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
import { loadInstructions, generateTemplate } from '@/instruction/agentsMd.js'
import { loadCustomCommands, renderTemplate } from '@/instruction/customCommands.js'
import { listCheckpoints, restoreCheckpoint } from '@/tools/checkpoint.js'
import type { Checkpoint } from '@/tools/checkpoint.js'
import { loadPromptHistory, appendPromptHistory } from '@/services/PromptHistory.js'
import { diffText, formatDiff } from '@/utils/diff.js'
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
            const note = `📖 调用 ${event.tool}: ${inputStr.slice(0, 80)}`
            setHistory((h) => [
              ...h,
              { role: 'assistant', text: note },
            ])
            break
          }
          case 'tool_result': {
            const note = event.ok
              ? `✓ ${event.tool} 完成`
              : `✗ ${event.tool} 失败: ${event.content}`
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
                text: `❌ 错误: ${event.error.message}`,
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
          text: `❌ 启动失败: ${String(e)}`,
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
      { role: 'user' as const, text: `📋 [计划模式] ${requirement}` },
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
        copy[copy.length - 1] = { role: 'assistant' as const, text: `❌ 计划失败: ${String(e)}` }
        return copy
      })
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
      { role: 'user' as const, text: `🔧 [工作流] ${requirement}` },
    ])
    const stageLabels: Record<WorkflowStage, string> = {
      understand: '🧠 理解需求',
      implement: '⚙️ 实现代码',
      verify: '✅ 验证测试',
      summarize: '📋 回顾汇报',
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
              { role: 'assistant' as const, text: `  📖 ${event.tool}: ${event.summary}` },
            ])
            break
          case 'workflow_stage_end':
            // 阶段结束不额外渲染（文本已在 workflow_text 累积）
            break
          case 'workflow_done':
            setHistory((h) => [
              ...h,
              { role: 'assistant' as const, text: `\n✨ 工作流完成（四阶段全跑完）` },
            ])
            break
          case 'workflow_aborted':
            setHistory((h) => [
              ...h,
              { role: 'assistant' as const, text: `\n⚠ 工作流被中断（已完成阶段：${event.completedStages.join(', ') || '无'}）` },
            ])
            break
          case 'workflow_error':
            setHistory((h) => [
              ...h,
              { role: 'assistant' as const, text: `\n❌ ${event.stage} 阶段错误: ${event.error}` },
            ])
            break
        }
      }
    } catch (e) {
      setHistory((h) => [
        ...h,
        { role: 'assistant' as const, text: `❌ 工作流失败: ${String(e)}` },
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
    setHistory((h) => [...h, { role: 'assistant' as const, text: ok ? `✓ 已恢复 ${target.originalPath}` : `❌ 恢复失败` }])
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
          { role: 'assistant' as const, text: `✓ 已生成 ${targetPath}\n编辑它来约定 agent 在本项目的行为，提交 git 让全团队共享。` },
        ])
      } catch (e) {
        setHistory((h) => [
          ...h,
          { role: 'assistant' as const, text: `❌ 生成失败: ${String(e)}` },
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
          text: `✓ 已恢复会话（${msgs.length} 条消息）`,
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
            text: `可用命令：
/clear — 清空当前对话上下文
/cost — 显示本次会话 token 用量
/help — 显示此帮助
/model [名] — 查看或切换模型
/plan <需求> — 分析需求并产出实施计划（只读，不改文件）
/workflow <需求> — ★ 自动走"理解→实现→验证→回顾"四阶段完整工作流
/rewind [N] — 回滚文件到 Edit/Write 前的 checkpoint
/diff — 查看本会话所有改动（diff 格式）
/init — 生成 AGENTS.md 模板（项目级 agent 行为约定）
/agents — 显示当前加载的 AGENTS.md 指令
/sessions — 列出历史会话
/resume <N> — 恢复第 N 个历史会话
/exit — 退出 fuckcode`,
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
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          fuckcode <Text dimColor>v{version}</Text>
        </Text>
        {currentModel && <Text dimColor>模型: {currentModel}</Text>}
        <Text dimColor>原生中文交互的终端 AI 编码工具</Text>
      </Box>

      {history.map((m, i) => (
        <Box key={i} flexDirection="column">
          <Text color={m.role === 'user' ? 'green' : 'blue'}>
            {m.role === 'user' ? '你' : 'fuckcode'}: {m.text}
            {m.role === 'assistant' && m.text === '' && running ? '▋' : ''}
          </Text>
        </Box>
      ))}

      <Box marginTop={1}>
        <Text color="green">❯ </Text>
        <Text>{input}</Text>
        {!running && <Text color="gray">▋</Text>}
      </Box>

      {pendingPermission && (
        <Box
          marginTop={1}
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
        >
          <Text color="yellow" bold>
            ⚠ 权限请求：{pendingPermission.tool} 要执行
          </Text>
          <Text>{pendingPermission.summary.slice(0, 80)}</Text>
          <Text dimColor>允许？[y=允许 / n=拒绝 / Ctrl+C=拒绝]</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {pendingPermission
            ? '等待权限确认...'
            : running
              ? `正在生成（${currentModel}）... Ctrl+C 中断`
              : `${currentModel} · ${totalTokensRef.current.input + totalTokensRef.current.output} tokens · /help · /diff · /rewind · /exit`}
        </Text>
      </Box>
    </Box>
  )
}
