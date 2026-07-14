// src/repl/Repl.tsx
// M2 REPL：欢迎框 + 输入框 + 流式对话历史。
// 回车把文本喂给 queryLoop，流式累积 assistant 文本。
// Ctrl+C 运行中中断当前轮次，空闲时退出。
//
// M4：工具执行前若 queryLoop yield permission_request，渲染权限弹窗，
//   用户按 y/n 后调 resolve('allow'|'deny') 让 queryLoop 继续。
// M5：启动期创建 session，每次 runQuery 把 sessionId + contextWindow 传给 queryLoop，
//   queryLoop 负责 loadMessages/appendMessages/autoCompact。
//   /sessions 列出历史会话；/resume [N] 恢复历史会话（替换 chatHistoryRef + sessionId）。
import React, { useState, useRef, useEffect } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import type { ChatMessage } from '@/llm/types.js'
import { queryLoop } from '@/agent/queryLoop.js'
import { buildSystemPrompt } from '@/agent/systemPrompt.js'
import { PLAN_MODE_INSTRUCTION } from '@/agent/planPrompt.js'
import { runWorkflow } from '@/agent/workflow.js'
import type { WorkflowStage } from '@/agent/workflow.js'
import { runGoal } from '@/agent/goalRunner.js'
import { attitudeFor, BANNER, TAGLINE, toolTag, STATUS, divider } from '@/personality.js'
import { loadInstructions, generateTemplate } from '@/instruction/agentsMd.js'
import { loadCustomCommands, renderTemplate } from '@/instruction/customCommands.js'
import { listCheckpoints, restoreCheckpoint } from '@/tools/checkpoint.js'
import type { Checkpoint } from '@/tools/checkpoint.js'
import { loadPromptHistory, appendPromptHistory } from '@/services/PromptHistory.js'
import { diffText, formatDiff } from '@/utils/diff.js'
import { estimateTokens } from '@/utils/tokens.js'
import { readFile } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getAllTools } from '@/tools/registry.js'
import { getConfig } from '@/services/runtime.js'
import type { PermissionMode } from '@/permissions/modes.js'
import type { PermissionUserDecision } from '@/agent/types.js'
import {
  createSession,
  listSessions,
  loadMessages,
} from '@/services/Session.js'
import type { SessionMeta } from '@/services/Session.js'

export interface ReplProps {
  version?: string
  /** 初始模型（来自 config 或 CLI --model 覆盖） */
  initialModel?: string
  /** 初始 apiKey（来自 config 或 CLI --api-key 覆盖） */
  initialApiKey?: string
  /** 初始 apiBaseUrl（来自 config 或 CLI --api-base-url 覆盖） */
  initialApiBaseUrl?: string
}

interface DisplayMessage {
  role: 'user' | 'assistant'
  text: string
}

// M4：权限弹窗的待处理状态。resolve 是 queryLoop 注入的回调，
// 用户回复后调一次 resolve 让 queryLoop 的 await 解除阻塞。
interface PendingPermission {
  tool: string
  summary: string
  resolve: (d: PermissionUserDecision) => void
}

export function Repl({ version = '0.1.0', initialModel, initialApiKey, initialApiBaseUrl }: ReplProps) {
  // M6+: 当前模型（支持 /model 运行时切换）。初值来自 CLI flag > config
  const [currentModel, setCurrentModel] = useState(initialModel ?? 'claude-sonnet-4-5-20250929')
  const { exit } = useApp()
  const [input, setInput] = useState('')
  // v1.2: 输入历史（↑↓ 浏览）
  const inputHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef<number>(-1) // -1 表示当前输入，>=0 表示浏览历史第 N 项
  const [history, setHistory] = useState<DisplayMessage[]>([])
  const [running, setRunning] = useState(false)
  // UX: Tab 补全状态（输入 / 后 Tab 显示命令列表）
  const [tabCompletions, setTabCompletions] = useState<string[] | null>(null)
  const [tabIndex, setTabIndex] = useState(0)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [pendingPermission, setPendingPermission] =
    useState<PendingPermission | null>(null)
  // M5：当前会话 id（启动期创建）。null 表示尚未就绪（首次创建 in flight）。
  const [sessionId, setSessionId] = useState<string | null>(null)
  const chatHistoryRef = useRef<ChatMessage[]>([])
  const abortRef = useRef<AbortController | null>(null)
  // M6: /cost 命令用的累计 token 统计
  const totalTokensRef = useRef({ input: 0, output: 0, cacheRead: 0 })
  const configRef = useRef<{
    model: string
    apiKey?: string
    apiBaseUrl?: string
    fallbackModels?: string[]
    maxTokens: number
    contextWindow: number
    permissionMode: PermissionMode
    permissions: { allow: string[]; ask: string[]; deny: string[] }
  } | null>(null)
  // 持有 pendingPermission 的最新引用（useInput 闭包读不到 React 最新 state）
  const pendingPermissionRef = useRef<PendingPermission | null>(null)
  // M5：/sessions 列表展示的最近会话（/resume N 取第 N 项）
  const sessionsListRef = useRef<SessionMeta[]>([])

  // 启动时读一次 config + 创建 session（异步，失败用默认值）
  useEffect(() => {
    getConfig()
      .then((c) => {
        // CLI flag > config（initialModel 已经在 App.tsx 做过 CLI>config 合并，这里优先用它）
        configRef.current = {
          model: initialModel ?? c.value.model,
          apiKey: initialApiKey ?? c.value.apiKey,
          apiBaseUrl: initialApiBaseUrl ?? c.value.apiBaseUrl,
          fallbackModels: c.value.fallbackModels,
          maxTokens: c.value.maxTokens,
          contextWindow: c.value.contextWindow,
          permissionMode: c.value.permissionMode,
          permissions: c.value.permissions,
        }
      })
      .catch(() => {
        configRef.current = {
          model: 'claude-sonnet-4-5-20250929',
          maxTokens: 8192,
          contextWindow: 200000,
          permissionMode: 'default',
          permissions: { allow: [], ask: [], deny: [] },
        }
      })
      .finally(() => setConfigLoaded(true))
    // 创建初始 session（失败不致命：queryLoop 不传 sessionId 仍能跑）
    createSession(process.cwd()).then(setSessionId).catch(() => {})
    // v1.7: 加载跨会话输入历史（inputHistoryRef 用"旧在前"顺序，loadPromptHistory 返回"最近在前"，需反转）
    loadPromptHistory(process.cwd())
      .then((hist) => { inputHistoryRef.current = hist.slice().reverse() })
      .catch(() => {})
  }, [])

  async function runQuery(text: string) {
    const config = configRef.current ?? {
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: 8192,
      contextWindow: 200000,
      permissionMode: 'default' as PermissionMode,
      permissions: { allow: [], ask: [], deny: [] },
    }
    const ac = new AbortController()
    abortRef.current = ac
    setRunning(true)

    let assistantText = ''
    // 立即新增 user + 空 assistant 两条消息
    setHistory((h) => [
      ...h,
      { role: 'user', text },
      { role: 'assistant', text: '' },
    ])

    try {
      for await (const event of queryLoop({
        history: chatHistoryRef.current,
        userInput: text,
        model: config.model,
        system: await buildSystemPrompt({ tools: getAllTools() }),
        maxTokens: config.maxTokens,
        signal: ac.signal,
        apiKey: config.apiKey,
        ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
        ...(config.fallbackModels ? { fallbackModels: config.fallbackModels } : {}),
        cwd: process.cwd(),
        tools: getAllTools(),
        // M4：传权限模式 + 规则给 queryLoop，工具执行前调 checkPermission
        permissionMode: config.permissionMode,
        permissions: config.permissions,
        // M5：会话持久化 + autoCompact 阈值
        sessionId: sessionId ?? undefined,
        contextWindow: config.contextWindow,
      })) {
        switch (event.type) {
          case 'text_delta':
            assistantText += event.text
            setHistory((h) => {
              const copy = [...h]
              copy[copy.length - 1] = { role: 'assistant', text: assistantText }
              return copy
            })
            break
          case 'tool_use_start': {
            // 渲染"📖 调用 {tool}"提示（input 截断到 80 字符避免刷屏）
            const inputStr = JSON.stringify(event.input) ?? ''
            const note = `${toolTag(event.tool)} ${inputStr.slice(0, 80)}`
            setHistory((h) => [
              ...h,
              { role: 'assistant', text: note },
            ])
            break
          }
          case 'tool_result': {
            const note = event.ok
              ? `${STATUS.ok} ${event.tool}`
              : `${STATUS.fail} ${event.tool}: ${event.content}`
            setHistory((h) => [
              ...h,
              { role: 'assistant', text: note },
            ])
            break
          }
          case 'permission_request': {
            // 设置 pendingPermission 状态：弹窗渲染 + useInput 接管输入等 y/n
            // 同时写 ref（useInput 闭包读 ref，避免 stale state）
            const pending: PendingPermission = {
              tool: event.tool,
              summary: event.inputSummary,
              resolve: event.resolve,
            }
            pendingPermissionRef.current = pending
            setPendingPermission(pending)
            break
          }
          case 'compacted': {
            // 上下文已压缩 —— 告知用户（摘要前 80 字预览）。
            setHistory((h) => [
              ...h,
              {
                role: 'assistant',
                text: `📐 已压缩上下文（${event.summary.slice(0, 80)}...）`,
              },
            ])
            break
          }
          case 'turn_end':
            // 只在最终轮（非 tool_use）把本轮对话存入 chatHistoryRef。
            // 工具调用中间轮（stopReason='tool_use'）不存——避免重复 push
            // 和跨轮文本累积污染。
            // 注意：sessionId 存在时，磁盘历史由 queryLoop 维护，
            // chatHistoryRef 仅作显示用（M5 也可在 resume 后留空）。
            if (event.stopReason !== 'tool_use') {
              chatHistoryRef.current = [
                ...chatHistoryRef.current,
                { role: 'user', content: text },
                { role: 'assistant', content: assistantText },
              ]
            }
            break
          case 'aborted':
            if (assistantText) {
              chatHistoryRef.current = [
                ...chatHistoryRef.current,
                { role: 'user', content: text },
                { role: 'assistant', content: assistantText + ' [已中断]' },
              ]
            }
            break
          case 'error':
            setHistory((h) => [
              ...h,
              {
                role: 'assistant',
                text: `${attitudeFor('error')} ${event.error.message}`,
              },
            ])
            break
          case 'usage':
            // M6: 累加 token 用量（供 /cost 命令）
            totalTokensRef.current.input += event.input
            totalTokensRef.current.output += event.output
            totalTokensRef.current.cacheRead += event.cacheRead
            break
          case 'done':
            break
        }
      }
    } catch (e) {
      setHistory((h) => {
        const copy = [...h]
        copy[copy.length - 1] = {
          role: 'assistant',
          text: `靠，炸了: ${String(e)}`,
        }
        return copy
      })
    } finally {
      setRunning(false)
      abortRef.current = null
      // 兜底：异常退出（如 queryLoop 抛错）时若 pendingPermission 残留，
      // resolve('deny') 让任何 await 中的 promise 解除阻塞，避免挂死。
      if (pendingPermissionRef.current) {
        pendingPermissionRef.current.resolve('deny')
        pendingPermissionRef.current = null
        setPendingPermission(null)
      }
    }
  }

  // v0.2b: /plan <需求> —— 用 plan 模式分析需求，产出实施计划（只读，不改文件）
  // 与 runQuery 区别：permissionMode='plan'（写工具被 deny）+ 叠加计划指令 system prompt
  async function runPlan(requirement: string) {
    const config = configRef.current ?? { model: 'claude-sonnet-4-5-20250929', maxTokens: 8192, contextWindow: 200000, permissionMode: 'default' as const, permissions: { allow: [], ask: [], deny: [] } }
    const ac = new AbortController()
    abortRef.current = ac
    setRunning(true)
    let planText = ''
    setHistory((h) => [
      ...h,
      { role: 'user' as const, text: `[PLAN]  ${requirement}` },
      { role: 'assistant' as const, text: '' },
    ])
    try {
      const planSystem = (await buildSystemPrompt({ tools: getAllTools() })) + PLAN_MODE_INSTRUCTION
      for await (const event of queryLoop({
        history: [],
        userInput: `请为以下需求产出一份实施计划：\n\n${requirement}`,
        model: currentModel,
        system: planSystem,
        maxTokens: config.maxTokens,
        signal: ac.signal,
        apiKey: config.apiKey,
        ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
        ...(config.fallbackModels ? { fallbackModels: config.fallbackModels } : {}),
        cwd: process.cwd(),
        tools: getAllTools(),
        permissionMode: 'plan', // 只读，写工具被 deny
        permissions: config.permissions,
        sessionId: sessionId ?? undefined,
        contextWindow: config.contextWindow,
      })) {
        if (event.type === 'text_delta') {
          planText += event.text
          setHistory((h) => {
            const copy = [...h]
            copy[copy.length - 1] = { role: 'assistant' as const, text: planText }
            return copy
          })
        } else if (event.type === 'usage') {
          totalTokensRef.current.input += event.input
          totalTokensRef.current.output += event.output
          totalTokensRef.current.cacheRead += event.cacheRead
        }
      }
    } catch (e) {
      setHistory((h) => {
        const copy = [...h]
        copy[copy.length - 1] = { role: 'assistant' as const, text: `计划泡汤: ${String(e)}` }
        return copy
      })
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  // v1.11: /goal <条件> 目标驱动持续工作
  async function runGoalTask(goal: string) {
    const config = configRef.current ?? { model: 'claude-sonnet-4-5-20250929', maxTokens: 8192, contextWindow: 200000, permissionMode: 'default' as const, permissions: { allow: [], ask: [], deny: [] } }
    const ac = new AbortController()
    abortRef.current = ac
    setRunning(true)
    setHistory((h) => [...h, { role: 'user' as const, text: `[GOAL]  ${goal}` }])
    try {
      for await (const event of runGoal({
        goal,
        model: currentModel,
        apiKey: config.apiKey,
        ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
        ...(config.fallbackModels ? { fallbackModels: config.fallbackModels } : {}),
        signal: ac.signal,
        cwd: process.cwd(),
        config: { maxTokens: config.maxTokens, contextWindow: config.contextWindow, permissions: config.permissions },
        sessionId: sessionId ?? undefined,
        maxTurns: 10,
      })) {
        switch (event.type) {
          case 'goal_start':
            setHistory((h) => [...h, { role: 'assistant' as const, text: `[GOAL] ${event.goal}（最多 ${event.maxTurns} 轮）\n` }])
            break
          case 'goal_turn_start':
            setHistory((h) => [...h, { role: 'assistant' as const, text: `\n--- 第 ${event.turn} 轮工作 ---\n` }, { role: 'assistant' as const, text: '' }])
            break
          case 'goal_work':
            setHistory((h) => {
              const copy = [...h]
              const last = copy[copy.length - 1]
              if (last && last.role === 'assistant') {
                copy[copy.length - 1] = { role: 'assistant' as const, text: last.text + event.text }
              }
              return copy
            })
            break
          case 'goal_tool':
            setHistory((h) => [...h, { role: 'assistant' as const, text: `  ${toolTag(event.tool)} ${event.summary}` }])
            break
          case 'goal_checking':
            setHistory((h) => [...h, { role: 'assistant' as const, text: `\n[CHECK] 查目标达成没...` }])
            break
          case 'goal_achieved':
            setHistory((h) => [...h, { role: 'assistant' as const, text: `\n目标算是达成了（折腾了 ${event.turn} 轮）` }])
            break
          case 'goal_max_turns':
            setHistory((h) => [...h, { role: 'assistant' as const, text: `\n操，跑了 ${event.turns} 轮还没搞定，老子不干了` }])
            break
          case 'goal_aborted':
            setHistory((h) => [...h, { role: 'assistant' as const, text: `\n被打断了（搞了 ${event.turns} 轮）` }])
            break
          case 'goal_error':
            setHistory((h) => [...h, { role: 'assistant' as const, text: `\n[FAIL] 目标出错: ${event.error}` }])
            break
        }
      }
    } catch (e) {
      setHistory((h) => [...h, { role: 'assistant' as const, text: `目标黄了: ${String(e)}` }])
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  // v1.0 核心差异化：/workflow <需求> —— 自动走"理解→实现→验证→回顾"四阶段
  async function runWorkflowTask(requirement: string) {
    const config = configRef.current ?? { model: 'claude-sonnet-4-5-20250929', maxTokens: 8192, contextWindow: 200000, permissionMode: 'default' as const, permissions: { allow: [], ask: [], deny: [] } }
    const ac = new AbortController()
    abortRef.current = ac
    setRunning(true)
    setHistory((h) => [
      ...h,
      { role: 'user' as const, text: `[FLOW]  ${requirement}` },
    ])
    const stageLabels: Record<WorkflowStage, string> = {
      understand: '[THINK] 理解',
      implement: '[BUILD] 实现',
      verify: '[PASS] 验证',
      summarize: '[DONE] 回顾',
    }
    try {
      for await (const event of runWorkflow({
        requirement,
        model: currentModel,
        apiKey: config.apiKey,
        ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
        signal: ac.signal,
        cwd: process.cwd(),
        config: {
          maxTokens: config.maxTokens,
          contextWindow: config.contextWindow,
          permissions: config.permissions,
        },
      })) {
        switch (event.type) {
          case 'workflow_stage_start':
            setHistory((h) => [
              ...h,
              { role: 'assistant' as const, text: `\n--- ${stageLabels[event.stage]} ---\n` },
              { role: 'assistant' as const, text: '' },
            ])
            break
          case 'workflow_text': {
            // 追加到当前阶段最后一条 assistant 消息
            setHistory((h) => {
              const copy = [...h]
              const last = copy[copy.length - 1]
              if (last && last.role === 'assistant') {
                copy[copy.length - 1] = { role: 'assistant' as const, text: last.text + event.textDelta }
              }
              return copy
            })
            break
          }
          case 'workflow_tool':
            setHistory((h) => [
              ...h,
              { role: 'assistant' as const, text: `  ${toolTag(event.tool)} ${event.summary}` },
            ])
            break
          case 'workflow_stage_end':
            // 阶段结束不额外渲染（文本已在 workflow_text 累积）
            break
          case 'workflow_done':
            setHistory((h) => [
              ...h,
              { role: 'assistant' as const, text: `\n齐活了，四阶段跑完。` },
            ])
            break
          case 'workflow_aborted':
            setHistory((h) => [
              ...h,
              { role: 'assistant' as const, text: `\n[WARN] 工作流被中断（已完成阶段：${event.completedStages.join(', ') || '无'}）` },
            ])
            break
          case 'workflow_error':
            setHistory((h) => [
              ...h,
              { role: 'assistant' as const, text: `\n[FAIL] ${event.stage} 阶段: ${event.error}` },
            ])
            break
        }
      }
    } catch (e) {
      setHistory((h) => [
        ...h,
        { role: 'assistant' as const, text: `工作流拉胯了: ${String(e)}` },
      ])
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  // v1.6: /rewind 列出/恢复文件 checkpoint（Edit/Write 前自动备份）
  async function handleRewindCommand(text: string): Promise<void> {
    const parts = text.split(/\s+/)
    const idx = parts[1] ? parseInt(parts[1]) - 1 : NaN
    const checkpoints = await listCheckpoints(process.cwd())
    if (checkpoints.length === 0) {
      setHistory((h) => [...h, { role: 'assistant' as const, text: '没有可回滚的 checkpoint（Edit/Write 改文件时会自动创建）' }])
      return
    }
    // 无序号：列出最近的
    if (isNaN(idx)) {
      const recent = checkpoints.slice(0, 10)
      const list = recent.map((c, i) => {
        const time = new Date(c.timestamp).toLocaleString('zh-CN')
        const shortPath = c.originalPath.replace(process.cwd() + '/', '')
        return `${i + 1}. ${shortPath}（${time}，${c.size}B）`
      }).join('\n')
      setHistory((h) => [...h, { role: 'assistant' as const, text: `最近的 checkpoint：\n${list}\n\n输入 /rewind <序号> 恢复` }])
      return
    }
    // 有序号：恢复
    const target = checkpoints[idx]
    if (!target) {
      setHistory((h) => [...h, { role: 'assistant' as const, text: `无效序号（共 ${checkpoints.length} 个，最近 10 个可回滚）` }])
      return
    }
    const ok = await restoreCheckpoint(process.cwd(), target.id)
    setHistory((h) => [...h, { role: 'assistant' as const, text: ok ? `[ OK ] 已恢复 ${target.originalPath}` : `[FAIL] 恢复失败` }])
  }

  // v1.12: /less-permission-prompts 分析历史并生成 allowlist 建议
  async function handleLessPermissionsCommand(): Promise<void> {
    // 从 inputHistoryRef 读历史 prompt（找含 Bash 命令意图的）
    // 简化版：直接建议常见只读 Bash 模式 + 扫描 checkpoint 看改过哪些文件
    const checkpoints = await listCheckpoints(process.cwd())
    const changedFiles = new Set(checkpoints.map((c) => c.originalPath.replace(process.cwd() + '/', '')))

    // 常见安全的只读 Bash 命令模式（用户大概率频繁用）
    const commonSafe = [
      { pattern: 'git status', desc: '查看 git 状态' },
      { pattern: 'git diff*', desc: '查看改动' },
      { pattern: 'git log*', desc: '查看提交历史' },
      { pattern: 'git branch*', desc: '查看分支' },
      { pattern: 'ls*', desc: '列目录' },
      { pattern: 'cat*', desc: '查看文件' },
      { pattern: 'echo*', desc: '输出文本' },
      { pattern: 'node --version', desc: '查看 node 版本' },
      { pattern: 'bun --version', desc: '查看 bun 版本' },
    ]

    const suggestions = commonSafe.map((s) => `  "Bash(${s.pattern})"  // ${s.desc}`).join('\n')
    const filesNote = changedFiles.size > 0
      ? `\n\n你常改的文件：\n${[...changedFiles].slice(0, 10).map((f) => `  ${f}`).join('\n')}\n可考虑加 "Edit(${[...changedFiles][0]?.split('/')[0]}/**)" 减少弹窗`
      : ''

    setHistory((h) => [...h, {
      role: 'assistant' as const,
      text: `减少权限弹窗的建议（加到 ~/.fuckcode/config.json 的 permissions.allow）：

${suggestions}${filesNote}

复制需要的条目到 config.json 即可。加完后这些命令不再弹窗确认。`,
    }])
  }

  // v1.11: /context 分析当前上下文 token 占用（各类内容分别占多少）
  async function handleContextCommand(): Promise<void> {
    const history = chatHistoryRef.current
    if (history.length === 0) {
      setHistory((h) => [...h, { role: 'assistant' as const, text: '当前无对话上下文' }])
      return
    }
    // 分类统计：user 文本 / assistant 文本 / tool_result / 结构化 block
    let userTokens = 0
    let assistantTokens = 0
    let toolResultTokens = 0
    for (const msg of history) {
      if (typeof msg.content === 'string') {
        const t = estimateTokens(msg.content)
        if (msg.role === 'user') userTokens += t
        else assistantTokens += t
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') {
            const t = estimateTokens(block.text)
            if (msg.role === 'user') userTokens += t
            else assistantTokens += t
          } else if (block.type === 'tool_result') {
            toolResultTokens += estimateTokens(block.content)
          } else if (block.type === 'tool_use') {
            assistantTokens += estimateTokens(JSON.stringify(block.input))
          }
        }
      }
    }
    const total = userTokens + assistantTokens + toolResultTokens
    const config = configRef.current
    const contextWindow = config?.contextWindow ?? 200000
    const pct = Math.round((total / contextWindow) * 100)
    // 建议
    const tips: string[] = []
    if (toolResultTokens > total * 0.4) tips.push('• 工具结果占比高（>40%），考虑用 microCompact 压缩旧结果')
    if (pct > 80) tips.push('• 上下文已用 >80%，即将触发 autoCompact')
    if (assistantTokens > total * 0.5) tips.push('• assistant 回复占比高，长回复可考虑精简')

    setHistory((h) => [...h, {
      role: 'assistant' as const,
      text: `上下文占用分析（共 ${total} tokens / ${contextWindow}，${pct}%）：

  • 用户输入：${userTokens} tokens（${Math.round(userTokens / total * 100) || 0}%）
  • 模型回复：${assistantTokens} tokens（${Math.round(assistantTokens / total * 100) || 0}%）
  • 工具结果：${toolResultTokens} tokens（${Math.round(toolResultTokens / total * 100) || 0}%）
  • 消息数：${history.length}

${tips.length > 0 ? '优化建议：\n' + tips.join('\n') : '上下文占用健康。'}`,
    }])
  }

  // v1.10: /diff 查看本会话改动（基于 checkpoint 对比当前文件）
  async function handleDiffCommand(): Promise<void> {
    const checkpoints = await listCheckpoints(process.cwd())
    if (checkpoints.length === 0) {
      setHistory((h) => [...h, { role: 'assistant' as const, text: '没有改动记录（Edit/Write 改文件时会自动 checkpoint）' }])
      return
    }
    const byFile = new Map<string, Checkpoint>()
    for (const cp of checkpoints) {
      if (!byFile.has(cp.originalPath)) byFile.set(cp.originalPath, cp)
    }
    const diffs: string[] = []
    for (const [filePath, cp] of byFile) {
      try {
        const oldContent = await readFile(cp.checkpointPath, 'utf8')
        const newContent = await readFile(filePath, 'utf8').catch(() => '(文件已删除)')
        const d = diffText(oldContent, newContent)
        const shortPath = filePath.replace(process.cwd() + '/', '')
        const stats = d.filter((l) => l.type === 'add').length + ' 增 / ' + d.filter((l) => l.type === 'del').length + ' 删'
        diffs.push(`### ${shortPath}（${stats}）\n${formatDiff(d, 2)}`)
      } catch {
        // checkpoint 读失败跳过
      }
    }
    setHistory((h) => [...h, { role: 'assistant' as const, text: `本会话改动（${byFile.size} 个文件）：\n\n${diffs.join('\n\n').slice(0, 5000)}` }])
  }

  // v1.1: 自定义斜杠命令（.fuckcode/commands/*.md）
  async function handleCustomCommand(name: string, args: string): Promise<void> {
    const commands = await loadCustomCommands(process.cwd())
    const cmd = commands.find((c) => c.name === name)
    if (!cmd) {
      setHistory((h) => [
        ...h,
        { role: 'assistant' as const, text: `未知命令: /${name}\n输入 /help 查看内置命令，或在 .fuckcode/commands/ 创建 ${name}.md 自定义。` },
      ])
      return
    }
    const prompt = renderTemplate(cmd.template, args)
    // 如果命令指定了 model，临时切换
    if (cmd.model && cmd.model !== currentModel) {
      setCurrentModel(cmd.model)
      if (configRef.current) configRef.current.model = cmd.model
    }
    // 当作普通 query 跑
    setHistory((h) => [...h, { role: 'user' as const, text: `/${name}${args ? ' ' + args : ''}` }])
    void runQuery(prompt)
  }

  // v0.3: /init 生成 AGENTS.md / /agents 显示当前指令（异步命令）
  async function handleInstructionCommand(text: string): Promise<void> {
    if (text === '/init') {
      const targetPath = resolve(process.cwd(), 'AGENTS.md')
      try {
        await writeFile(targetPath, generateTemplate(process.cwd()), 'utf8')
        setHistory((h) => [
          ...h,
          { role: 'assistant' as const, text: `[ OK ] 已生成 ${targetPath}\n编辑它来约定 agent 在本项目的行为，提交 git 让全团队共享。` },
        ])
      } catch (e) {
        setHistory((h) => [
          ...h,
          { role: 'assistant' as const, text: `[FAIL] 生成失败: ${String(e)}` },
        ])
      }
      return
    }
    // /agents /instructions
    const instr = await loadInstructions(process.cwd())
    setHistory((h) => [
      ...h,
      {
        role: 'assistant' as const,
        text: instr
          ? `当前加载的 AGENTS.md 指令：\n\n${instr.slice(0, 2000)}${instr.length > 2000 ? '\n...（截断）' : ''}`
          : '未找到 AGENTS.md。用 /init 生成模板。',
      },
    ])
  }

  // M5：/sessions 与 /resume 命令（异步，useInput 回调本身不能 await）。
  // - /sessions：列出最近 5 个会话（倒序，最近在前），存到 sessionsListRef
  // - /resume [N]：取 sessionsListRef 第 N 项恢复 —— loadMessages 替换 chatHistoryRef
  //   + setSessionId 让后续 runQuery 走恢复路径
  async function handleSessionCommand(text: string): Promise<boolean> {
    if (text === '/sessions' || text === '/resume') {
      const sessions = await listSessions(process.cwd())
      if (sessions.length === 0) {
        setHistory((h) => [
          ...h,
          { role: 'assistant', text: '没有历史会话' },
        ])
      } else {
        // listSessions 已按 lastMessageAt 倒序（最近在前），取前 5 个
        const recent = sessions.slice(0, 5)
        sessionsListRef.current = recent
        const list = recent
          .map(
            (s, i) =>
              `${i + 1}. ${s.title}（${s.messageCount} 条，${new Date(
                s.lastMessageAt,
              ).toLocaleString('zh-CN')}）`,
          )
          .join('\n')
        setHistory((h) => [
          ...h,
          { role: 'assistant', text: `历史会话：\n${list}\n\n输入 /resume <序号> 恢复` },
        ])
      }
      setInput('')
      return true
    }
    if (text.startsWith('/resume ')) {
      const idx = parseInt(text.split(' ')[1] ?? '', 10) - 1
      const sessions = sessionsListRef.current
      const target = Number.isNaN(idx) ? undefined : sessions[idx]
      if (!target) {
        setHistory((h) => [
          ...h,
          { role: 'assistant', text: '无效的序号。先 /sessions 查看列表。' },
        ])
        setInput('')
        return true
      }
      const msgs = await loadMessages(target.id, process.cwd()).catch(
        () => [] as ChatMessage[],
      )
      chatHistoryRef.current = msgs
      setSessionId(target.id)
      setHistory((h) => [
        ...h,
        {
          role: 'assistant',
          text: `[ OK ] 已恢复会话（${msgs.length} 条消息）`,
        },
      ])
      setInput('')
      return true
    }
    return false
  }

  useInput((inputChar, key) => {
    // 权限弹窗激活时接管输入：只接 y/n（大小写都行），其他键忽略。
    // 读 ref 而非 state（useInput 闭包持有的是首次注册时的 state，看不到后续更新）。
    const pending = pendingPermissionRef.current
    if (pending) {
      if (inputChar === 'y' || inputChar === 'Y') {
        pending.resolve('allow')
        pendingPermissionRef.current = null
        setPendingPermission(null)
        return
      }
      if (inputChar === 'n' || inputChar === 'N') {
        pending.resolve('deny')
        pendingPermissionRef.current = null
        setPendingPermission(null)
        return
      }
      // Ctrl+C 在弹窗中视为拒绝（让用户能快速 escape）
      if (key.ctrl && (inputChar === 'c' || inputChar === 'd')) {
        pending.resolve('deny')
        pendingPermissionRef.current = null
        setPendingPermission(null)
        return
      }
      return // 其他键忽略，继续等 y/n
    }
    // Ctrl+C / Ctrl+D：运行中中断，空闲退出
    if (key.ctrl && (inputChar === 'c' || inputChar === 'd')) {
      if (running && abortRef.current) {
        abortRef.current.abort()
        return
      }
      exit()
      return
    }
    // UX: Esc 清空输入（退出 Tab 补全模式）
    if (inputChar === '\x1b' || key.escape) {
      if (tabCompletions) {
        setTabCompletions(null)
        setTabIndex(0)
      } else {
        setInput('')
      }
      return
    }
    // UX: Ctrl+L 清屏（清空显示历史，保留对话上下文）
    if (key.ctrl && inputChar === 'l') {
      setHistory([])
      setTabCompletions(null)
      return
    }
    // UX: Tab 补全（输入 / 开头时列出/切换命令）
    if (key.tab && input.startsWith('/')) {
      const allCommands = [
        '/help', '/exit', '/quit', '/clear', '/cost', '/model', '/context',
        '/workflow', '/goal', '/plan', '/diff', '/rewind', '/less-perms',
        '/init', '/agents', '/sessions', '/resume', '/instructions',
      ]
      const matches = allCommands.filter((c) => c.startsWith(input))
      if (matches.length === 0) {
        setTabCompletions(null)
      } else if (tabCompletions && tabCompletions.length > 0) {
        // 已在补全模式：切换到下一个
        const next = (tabIndex + 1) % tabCompletions.length
        setTabIndex(next)
        setInput(tabCompletions[next]!)
      } else {
        // 首次 Tab：显示匹配列表，填入第一个
        setTabCompletions(matches)
        setTabIndex(0)
        setInput(matches[0]!)
      }
      return
    }
    // 非 / 开头或非 tab：清除补全状态
    if (tabCompletions) {
      setTabCompletions(null)
      setTabIndex(0)
    }
    // 回车提交
    if (key.return) {
      const text = input.trim()
      if (text === '/exit' || text === '/quit') {
        exit()
        return
      }
      if (text === '/clear') {
        chatHistoryRef.current = []
        setHistory([])
        setInput('')
        return
      }
      // M6: /cost 显示 token 用量
      if (text === '/cost') {
        const t = totalTokensRef.current
        setHistory((h) => [
          ...h,
          {
            role: 'assistant' as const,
            text: `本次会话用量：输入 ${t.input} / 输出 ${t.output} / 缓存读 ${t.cacheRead} tokens`,
          },
        ])
        setInput('')
        return
      }
      // M6+: /model 查看或切换模型（运行时生效，下次对话用新模型）
      if (text === '/model') {
        setHistory((h) => [
          ...h,
          {
            role: 'assistant' as const,
            text: `当前模型：${currentModel}\n\n切换：/model <模型名>\n常用：\n  claude-sonnet-4-5-20250929（默认，均衡）\n  claude-opus-4-1-20250805（强，贵）\n  claude-haiku-3-5（快，便宜）\n  或第三方兼容模型名`,
          },
        ])
        setInput('')
        return
      }
      if (text.startsWith('/model ')) {
        const newModel = text.slice('/model '.length).trim()
        if (newModel) {
          setCurrentModel(newModel)
          if (configRef.current) configRef.current.model = newModel
          setHistory((h) => [
            ...h,
            { role: 'assistant' as const, text: `✓ 模型已切换为 ${newModel}（下次对话生效）` },
          ])
        }
        setInput('')
        return
      }
      // v1.6: /rewind 文件 checkpoint 回滚（Edit/Write 前自动备份）
      if (text === '/rewind' || text.startsWith('/rewind ')) {
        if (!running) {
          setInput('')
          void handleRewindCommand(text)
        }
        return
      }
      // v1.10: /diff 查看本会话改动
      if (text === '/diff') {
        if (!running) {
          setInput('')
          void handleDiffCommand()
        }
        return
      }
      // v1.11: /context 分析上下文 token 占用
      if (text === '/context') {
        if (!running) {
          setInput('')
          void handleContextCommand()
        }
        return
      }
      // v1.12: /less-permission-prompts 生成 allowlist 建议
      if (text === '/less-permission-prompts' || text === '/less-perms') {
        if (!running) {
          setInput('')
          void handleLessPermissionsCommand()
        }
        return
      }
      // v1.11: /goal <条件> 目标驱动持续工作（跨轮次直到达成）
      if (text.startsWith('/goal ')) {
        const goal = text.slice('/goal '.length).trim()
        if (goal && !running) {
          setInput('')
          void runGoalTask(goal)
        }
        return
      }
      // v1.0 核心差异化：/workflow <需求> 自动走"理解→实现→验证→回顾"四阶段
      if (text.startsWith('/workflow ')) {
        const requirement = text.slice('/workflow '.length).trim()
        if (requirement && !running) {
          setInput('')
          void runWorkflowTask(requirement)
        }
        return
      }
      // v0.3: /init 生成 AGENTS.md 模板 / /agents 显示指令（异步命令）
      if (text === '/init' || text === '/agents' || text === '/instructions') {
        if (!running) {
          setInput('')
          void handleInstructionCommand(text)
        }
        return
      }
      // v0.2b: /plan <需求> 用 plan 模式分析需求产出实施计划（只读，不改文件）
      if (text.startsWith('/plan ')) {
        const requirement = text.slice('/plan '.length).trim()
        if (requirement && !running) {
          setInput('')
          void runPlan(requirement)
        }
        return
      }
      // M6: /help 显示命令列表
      if (text === '/help' || text === '/?') {
        setHistory((h) => [
          ...h,
          {
            role: 'assistant' as const,
            text: `可用命令（输入 / 后按 Tab 补全）：

【工作流】
  /workflow <需求>  ★ 四阶段：理解→实现→验证→回顾
  /goal <条件>      目标驱动：持续工作直到达成
  /plan <需求>      只读分析，产出实施计划

【上下文】
  /context    分析 token 占用 + 优化建议
  /diff       查看本会话改动（diff 格式）
  /rewind [N] 回滚文件到 checkpoint
  /cost       显示 token 用量

【模型/权限】
  /model [名]     查看或切换模型
  /less-perms     生成 allowlist 减少弹窗

【项目/会话】
  /init           生成 AGENTS.md 模板
  /agents         显示 AGENTS.md 指令
  /sessions       列出历史会话
  /resume <N>     恢复历史会话
  /clear          清空当前上下文

【快捷键】
  Tab             补全斜杠命令
  ↑↓              浏览输入历史
  Esc             清空输入 / 退出补全
  Ctrl+C          中断生成 / 退出
  Ctrl+L          清屏

  /exit /quit     退出`,
          },
        ])
        setInput('')
        return
      }
      // M5：/sessions 与 /resume N 是异步命令，用 void 包装避免阻塞 useInput
      if (text === '/sessions' || text === '/resume' || text.startsWith('/resume ')) {
        if (!running) {
          setInput('')
          void handleSessionCommand(text)
        }
        return
      }
      // v1.1: 自定义斜杠命令（.fuckcode/commands/*.md）——未知 /xxx 时查自定义命令
      if (text.startsWith('/') && !text.startsWith('/ ')) {
        const cmdName = text.slice(1).split(/\s+/)[0] ?? ''
        const cmdArgs = text.slice(1 + cmdName.length).trim()
        if (cmdName && !running) {
          setInput('')
          void handleCustomCommand(cmdName, cmdArgs)
          return
        }
      }
      if (text && !running) {
        // v1.2+v1.7: 存入输入历史（内存 + 跨会话持久化）
        const hist = inputHistoryRef.current
        if (hist[hist.length - 1] !== text) {
          hist.push(text)
          if (hist.length > 100) hist.shift()
          // v1.7: 持久化到 ~/.fuckcode/history/<hash>.jsonl
          void appendPromptHistory(process.cwd(), text).catch(() => {})
        }
        historyIndexRef.current = -1
        setInput('')
        void runQuery(text)
      }
      return
    }
    // v1.2: ↑↓ 浏览输入历史
    if (key.upArrow) {
      const history = inputHistoryRef.current
      if (history.length > 0) {
        if (historyIndexRef.current === -1) {
          historyIndexRef.current = history.length - 1
        } else {
          historyIndexRef.current = Math.max(0, historyIndexRef.current - 1)
        }
        setInput(history[historyIndexRef.current] ?? '')
      }
      return
    }
    if (key.downArrow) {
      const history = inputHistoryRef.current
      if (historyIndexRef.current >= 0) {
        historyIndexRef.current++
        if (historyIndexRef.current >= history.length) {
          historyIndexRef.current = -1 // 回到当前输入
          setInput('')
        } else {
          setInput(history[historyIndexRef.current] ?? '')
        }
      }
      return
    }
    // 退格
    if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1))
      return
    }
    // 普通文本输入（支持中文 IME 一次提交多个字符 + 粘贴）
    // 原先 length === 1 会拒绝 IME 提交的"你好"（长度 2），导致中文只能逐字输入。
    // 改为：只要不是 ctrl/meta 组合、且至少含一个非控制字符，就追加。
    if (!key.ctrl && !key.meta && inputChar) {
      // 过滤纯控制字符（如孤立的 \x1b Esc），但保留所有可见文本（含中文/emoji）
      const hasVisible = /\S/.test(inputChar) && !/^\x1b+$/.test(inputChar)
      if (hasVisible) {
        setInput((s) => s + inputChar)
      }
    }
  })

  return (
    <Box flexDirection="column">
      {/* ASCII Banner（Spring Boot 式）+ 暴躁标语 */}
      <Box flexDirection="column" marginBottom={0}>
        <Text color="red" bold>{BANNER}</Text>
        <Text dimColor>                                          v{version}{currentModel ? ` · ${currentModel}` : ''}</Text>
        <Text color="yellow" italic>  {TAGLINE}  {attitudeFor('welcome')}</Text>
      </Box>

      {/* 消息流：user 和 assistant 视觉分明 */}
      {history.map((m, i) => {
        if (m.role === 'user') {
          // user 消息：> 前缀 + 绿色 + dim 背景（像 Claude Code）
          return (
            <Box key={i} marginTop={i === 0 ? 1 : 0}>
              <Text color="green" bold>{'> '}</Text>
              <Text color="green">{m.text}</Text>
            </Box>
          )
        }
        // assistant 消息：无前缀，白色/默认色
        // 工具调用类消息（以 [TAG] 开头）用 dim 色
        const isToolCall = /^\s*\[/.test(m.text)
        const isSectionHeader = /^---|齐活了|目标算是/.test(m.text)
        if (isToolCall) {
          return (
            <Box key={i} flexDirection="column" marginLeft={2}>
              <Text dimColor>{m.text}</Text>
            </Box>
          )
        }
        if (isSectionHeader) {
          return (
            <Box key={i} marginTop={1}>
              <Text color="yellow" bold>{m.text}</Text>
            </Box>
          )
        }
        return (
          <Box key={i} flexDirection="column">
            <Text color={m.text === '' && running ? 'blue' : 'white'}>
              {m.text}
              {m.text === '' && running ? <Text color="blue">▋</Text> : ''}
            </Text>
          </Box>
        )
      })}

      {/* Tab 补全列表 */}
      {tabCompletions && tabCompletions.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>── 补全（Tab 切换 · Esc 取消）──</Text>
          {tabCompletions.map((cmd, i) => (
            <Text key={cmd} color={i === tabIndex ? 'cyan' : 'gray'}>
              {i === tabIndex ? '▶ ' : '  '}{cmd}
            </Text>
          ))}
        </Box>
      )}

      {/* 权限弹窗 */}
      {pendingPermission && (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow" bold>[WARN] {pendingPermission.tool}</Text>
          <Text>{pendingPermission.summary.slice(0, 80)}</Text>
          <Text dimColor>[y] 允许 · [n] 拒绝 · [Ctrl+C] 拒绝</Text>
        </Box>
      )}

      {/* 输入框：独立区域，红色边框，暴躁主题 */}
      {!pendingPermission && (
        <Box marginTop={1} borderStyle="single" borderColor={running ? 'gray' : 'red'} paddingX={1}>
          <Text color={running ? 'gray' : 'yellow'} bold>{running ? '⏳ ' : '> '}</Text>
          <Text color={running ? 'gray' : 'white'}>{input}</Text>
          {!running && <Text color="red">▋</Text>}
        </Box>
      )}

      {/* 底部状态栏 */}
      <Box marginTop={0}>
        <Text dimColor>
          {pendingPermission
            ? attitudeFor('permission')
            : running
              ? `${attitudeFor('generating')} [Ctrl+C 中断]`
              : `${currentModel} · ${totalTokensRef.current.input + totalTokensRef.current.output} tok · ${attitudeFor('idle')}`}
        </Text>
      </Box>
    </Box>
  )
}
