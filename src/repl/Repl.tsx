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
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import type { ChatMessage, ContentBlock } from '@/llm/types.js'
import { queryLoop } from '@/agent/queryLoop.js'
import { buildSystemPrompt } from '@/agent/systemPrompt.js'
import { PLAN_MODE_INSTRUCTION } from '@/agent/planPrompt.js'
import { runWorkflow } from '@/agent/workflow.js'
import type { WorkflowStage } from '@/agent/workflow.js'
import { runGoal } from '@/agent/goalRunner.js'
import { attitudeFor, BANNER, TAGLINE, toolTag, STATUS, divider } from '@/personality.js'
import { CommandRegistry } from '@/repl/CommandRegistry.js'
import { MessageHistory } from '@/repl/MessageHistory.js'
import type { DisplayMessage } from '@/repl/MessageHistory.js'
import { MessageList } from '@/repl/components/MessageList.js'
import { InputBox } from '@/repl/components/InputBox.js'
import { StatusBar } from '@/repl/components/StatusBar.js'
import { CommandHints } from '@/repl/components/CommandHints.js'
import { loadInstructions, generateTemplate } from '@/instruction/agentsMd.js'
import { loadSkills } from '@/instruction/skills.js'
import { loadCustomCommands, renderTemplate } from '@/instruction/customCommands.js'
import { handleVimNormalKey } from '@/repl/vim.js'
import { takePendingQuestion } from '@/tools/AskUserQuestion.js'
import type { PendingQuestion } from '@/tools/AskUserQuestion.js'
import { listCheckpoints, restoreCheckpoint } from '@/tools/checkpoint.js'
import type { Checkpoint } from '@/tools/checkpoint.js'
import { loadPromptHistory, appendPromptHistory } from '@/services/PromptHistory.js'
import { diffText, formatDiff } from '@/utils/diff.js'
import { estimateTokens, estimateMessagesTokens } from '@/utils/tokens.js'
import { readFile, mkdir } from 'node:fs/promises'
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

// 全部斜杠命令（含详细说明 + 参数 + 用法，用于实时提示和 /help）
const ALL_COMMANDS: { cmd: string; desc: string; args?: string; example?: string }[] = [
  { cmd: '/workflow', desc: '自动走四阶段：理解需求→实现代码→验证测试→回顾汇报', args: '<需求>', example: '/workflow 给 README 加安装说明' },
  { cmd: '/goal', desc: '设定目标，持续工作直到达成（最多 10 轮）', args: '<目标>', example: '/goal 所有测试通过' },
  { cmd: '/plan', desc: '只读分析需求，产出实施计划（不改文件）', args: '<需求>', example: '/plan 重构认证模块' },
  { cmd: '/context', desc: '分析当前上下文各类 token 占比 + 优化建议', args: '', example: '/context' },
  { cmd: '/diff', desc: '查看本次会话修改了哪些文件（diff 格式）', args: '', example: '/diff' },
  { cmd: '/rewind', desc: '回滚文件到 Edit/Write 前的备份', args: '[序号]', example: '/rewind 或 /rewind 2' },
  { cmd: '/cost', desc: '显示本次会话累计 token 用量', args: '', example: '/cost' },
  { cmd: '/model', desc: '查看当前模型 / 切换到别的模型', args: '[模型名]', example: '/model 或 /model gpt-4o' },
  { cmd: '/config', desc: '查看或修改配置', args: '[key=value]', example: '/config model=gpt-4o' },
  { cmd: '/less-perms', desc: '分析常用操作，生成权限白名单减少弹窗', args: '', example: '/less-perms' },
  { cmd: '/skills', desc: '查看/创建 skill（领域知识包），如 /skills create vue-debug', args: '[create <名>]', example: '/skills 或 /skills create react-perf' },
  { cmd: '/reload-skills', desc: '重新扫描 skill/AGENTS.md 文件', args: '', example: '/reload-skills' },
  { cmd: '/init', desc: '生成 AGENTS.md 模板（项目级行为约定）', args: '', example: '/init' },
  { cmd: '/agents', desc: '显示当前加载的 AGENTS.md 指令内容', args: '', example: '/agents' },
  { cmd: '/sessions', desc: '列出本项目的历史会话', args: '', example: '/sessions' },
  { cmd: '/resume', desc: '恢复某个历史会话继续聊', args: '<序号>', example: '/resume 1' },
  { cmd: '/clear', desc: '清空当前对话上下文（不删历史文件）', args: '', example: '/clear' },
  { cmd: '/help', desc: '显示完整帮助（命令 + 快捷键）', args: '', example: '/help' },
  { cmd: '/snapshot', desc: '创建会话快照', args: '<标签>', example: '/snapshot 重构前' },
  { cmd: '/export', desc: '导出会话为 markdown', args: '', example: '/export' },
  { cmd: '/version', desc: '显示版本号', args: '', example: '/version' },
  { cmd: '/compact', desc: '手动触发上下文压缩', args: '', example: '/compact' },
  { cmd: '/memory', desc: '查看/增删记忆', args: '[add <名> <类型> <内容> | delete <名>]', example: '/memory 或 /memory add vue-style preference "用 <style scoped>"' },
  { cmd: '/hooks', desc: '查看 hook 配置', args: '', example: '/hooks' },
  { cmd: '/status', desc: '一屏查看运行状态', args: '', example: '/status' },
  { cmd: '/doctor', desc: '环境诊断', args: '', example: '/doctor' },
  { cmd: '/review', desc: '对本会话改动做代码审查', args: '', example: '/review' },
  { cmd: '/mcp', desc: '查看/管理 MCP server', args: '[reconnect <名> | disconnect <名> | tools <名>]', example: '/mcp 或 /mcp tools github' },
  { cmd: '/permissions', desc: '查看/修改权限规则', args: '[add <allow|ask|deny> <规则> | remove <组> <序号> | mode <模式>]', example: '/permissions 或 /permissions add allow "Bash(git *)"' },
  { cmd: '/add-dir', desc: '添加额外工作目录', args: '[<目录路径>]', example: '/add-dir ../other-project' },
  { cmd: '/emacs', desc: '查看 emacs 编辑快捷键', args: '', example: '/emacs' },
  { cmd: '/vim', desc: '开关 vim 输入模式（normal/insert 双模态）', args: '', example: '/vim' },
  { cmd: '/exit', desc: '退出 fuckcode', args: '', example: '/exit' },
  { cmd: '/quit', desc: '退出 fuckcode', args: '', example: '/quit' },
]

// 深度比对第 50 轮: 自定义命令缓存——异步加载后合并到 ALL_COMMANDS
let customCommandsCache: typeof ALL_COMMANDS = []
let customCommandsLoaded = false

async function ensureCustomCommandsLoaded(): Promise<void> {
  if (customCommandsLoaded) return
  customCommandsLoaded = true
  try {
    const { loadCustomCommands } = await import('@/instruction/customCommands.js')
    const commands = await loadCustomCommands(process.cwd())
    customCommandsCache = commands.map((c) => ({
      cmd: `/${c.name}`,
      desc: c.description ?? `自定义命令`,
      args: c.hints,
      example: c.hints ? `/${c.name} ${c.hints}` : `/${c.name}`,
    }))
  } catch {
    // 加载失败不阻塞
  }
}

// 实时过滤匹配的命令（含自定义命令）
async function matchCommandsAsync(input: string): Promise<typeof ALL_COMMANDS> {
  if (!input.startsWith('/')) return []
  await ensureCustomCommandsLoaded()
  const all = [...ALL_COMMANDS, ...customCommandsCache]
  return all.filter((c) => c.cmd.startsWith(input))
}

// 同步版（保持兼容，不含自定义命令）
function matchCommands(input: string): typeof ALL_COMMANDS {
  void ensureCustomCommandsLoaded()
  if (!input.startsWith('/')) return []
  const all = [...ALL_COMMANDS, ...customCommandsCache]
  return all.filter((c) => c.cmd.startsWith(input))
}

// 判断文本是"斜杠命令"还是"绝对路径/普通文本"。
// 关键区分：斜杠命令是 / 后跟命令名（小写字母/数字/连字符，如 /help /add-dir）；
// 而 Unix 绝对路径是 / 后跟路径段（含 / 或大写，如 /Users/... /tmp/...）。
// 规则：/ 后第一个 token 只含 [a-z0-9-] 且不含 / → 当命令；否则当普通文本。
function isSlashCommand(text: string): boolean {
  if (!text.startsWith('/')) return false
  // / 后取第一个空白前的 token（命令名部分，含前导 /）
  const token = text.split(/\s+/)[0] ?? text
  // 命令名格式：/ 后跟 1+ 个 [a-z0-9-] 字符，整体不含额外 /
  return /^\/[a-z0-9][a-z0-9-]*$/.test(token)
}

export interface ReplProps {
  version?: string
  /** 初始模型（来自 config 或 CLI --model 覆盖） */
  initialModel?: string
  /** 初始 apiKey（来自 config 或 CLI --api-key 覆盖） */
  initialApiKey?: string
  /** 初始 apiBaseUrl（来自 config 或 CLI --api-base-url 覆盖） */
  initialApiBaseUrl?: string
}


// M4：权限弹窗的待处理状态。resolve 是 queryLoop 注入的回调，
// 用户回复后调一次 resolve 让 queryLoop 的 await 解除阻塞。
interface PendingPermission {
  tool: string
  summary: string
  resolve: (d: PermissionUserDecision) => void
}

export function Repl({ version = '0.1.0', initialModel, initialApiKey, initialApiBaseUrl }: ReplProps) {
  // 深度比对修复 #5: 权限"总是允许"——记住决策不重复问
  const alwaysAllowRef = useRef<Set<string>>(new Set())
  // M6+: 当前模型（支持 /model 运行时切换）。初值来自 CLI flag > config
  const [currentModel, setCurrentModel] = useState(initialModel ?? 'claude-sonnet-4-5-20250929')
  const { exit } = useApp()
  const [input, setInput] = useState('')
  // 深度比对修复 #1: 光标 offset（行内编辑）
  const [cursorOffset, setCursorOffset] = useState(0)
  // v1.2: 输入历史（↑↓ 浏览）
  const inputHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef<number>(-1) // -1 表示当前输入，>=0 表示浏览历史第 N 项
  // refactor: MessageHistory 类管理对话历史（替代裸 useState + chatHistoryRef）
  const historyMgrRef = useRef(new MessageHistory()).current
  const [history, setHistoryRaw] = useState<DisplayMessage[]>([])
  // 委托 setHistory 给 MessageHistory（同步存储 + 触发 React 重渲染）
  const setHistory = useCallback((updater: DisplayMessage[] | ((prev: DisplayMessage[]) => DisplayMessage[])) => {
    setHistoryRaw((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      historyMgrRef.setDisplay(next)
      return next
    })
  }, [historyMgrRef])
  const [running, setRunning] = useState(false)
  // UX: 实时命令提示（输入 / 后下方显示匹配命令，↑↓ 选中，Tab 确认）
  const [cmdHintIndex, setCmdHintIndex] = useState(0)
  // 状态栏暴躁文案——缓存避免每次按键重渲染都变（用 ref + 只在状态切换时换）
  const idleAttitudeRef = useRef(attitudeFor('idle'))
  const genAttitudeRef = useRef(attitudeFor('generating'))
  // refactor: 命令注册中心（替代 17 个 if-else）
  const commandRegistryRef = useRef<CommandRegistry | null>(null)
  // 深度比对修复 #3: 流式渲染节流 timer
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 深度比对第 61 轮: Esc 双击防误触时间戳
  const escPressRef = useRef(0)
  // 深度比对修复 #8: thinking/reasoning 状态
  const thinkingTextRef = useRef('')
  const thinkingShownRef = useRef(false)
  // 深度比对修复 #7: 工具调用聚合（避免每个工具 push 两条消息刷屏）
  const toolBatchRef = useRef<{ tool: string; status: 'running' | 'ok' | 'fail'; id?: string }[]>([])
  const [configLoaded, setConfigLoaded] = useState(false)
  const [pendingPermission, setPendingPermission] =
    useState<PendingPermission | null>(null)
  // v1.19: 权限弹窗左右键选中索引（0=本次允许 1=总是允许 2=拒绝）。用 ref 避免 useInput 闭包 stale state
  const permSelRef = useRef(0)
  const [permSel, setPermSel] = useState(0)
  // v1.19: AskUserQuestion 弹窗——轮询 takePendingQuestion 消费
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null)
  const pendingQuestionRef = useRef<PendingQuestion | null>(null)
  const questionSelRef = useRef(0) // 当前选中索引
  const questionCheckedRef = useRef<Set<number>>(new Set()) // 多选已勾选项
  const [questionSel, setQuestionSel] = useState(0)
  const [questionChecked, setQuestionChecked] = useState<number[]>([])
  // v1.19: 子 agent（Task）状态——并发用计数 + 描述列表，状态栏显示"子 agent 在探索 xxx"
  const [subagentDescs, setSubagentDescs] = useState<string[]>([])
  const subagentDescsRef = useRef<string[]>([])
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
    provider?: 'anthropic' | 'openai' | 'openai-compatible'
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
  // v1.13: /add-dir 多目录工作区（Glob/Grep 跨目录搜索）
  const extraDirsRef = useRef<Set<string>>(new Set())
  // v1.18: vim modal 编辑（输入框行编辑，对标 Claude Code --vim）
  const vimEnabledRef = useRef(false)
  const vimModeRef = useRef<'normal' | 'insert'>('insert')
  const [vimIndicator, setVimIndicator] = useState<'normal' | 'insert' | null>(null) // null=vim 关

  // 启动时读一次 config + 创建 session（异步，失败用默认值）
  useEffect(() => {
    // refactor: 初始化逻辑与 useReplEngine hook 一致（getConfig + createSession + loadPromptHistory）
    // 未来 Repl 重写为纯渲染组件时可直接用 const engine = useReplEngine(initialModel)
    getConfig()
      .then((c) => {
        // CLI flag > config（initialModel 已经在 App.tsx 做过 CLI>config 合并，这里优先用它）
        configRef.current = {
          model: initialModel ?? c.value.model,
          apiKey: initialApiKey ?? c.value.apiKey,
          apiBaseUrl: initialApiBaseUrl ?? c.value.apiBaseUrl,
          provider: c.value.provider,
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
    // v1.13: 触发 SessionStart hook（对标 Claude Code SessionStart 事件）
    if (process.env.FUCKCODE_SAFE_MODE !== '1') {
      import('@/hooks/HookManager.js')
        .then(({ loadHooks, triggerHooks }) =>
          loadHooks(process.cwd()).then((hooks) =>
            triggerHooks('SessionStart', {}, hooks, process.cwd()).catch(() => {}),
          ),
        )
        .catch(() => {}) // hook 失败不阻塞启动
    }
    // v1.7: 加载跨会话输入历史（inputHistoryRef 用"旧在前"顺序，loadPromptHistory 返回"最近在前"，需反转）
    loadPromptHistory(process.cwd())
      .then((hist) => { inputHistoryRef.current = hist.slice().reverse() })
      .catch(() => {})
  }, [])

  // v1.19: 轮询 AskUserQuestion 的 pendingQuestion（它不是 queryLoop 事件，走全局队列）
  // takePendingQuestion 无 pending 时返回一个 pending Promise（等下次 setQuestion 触发）
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      while (!cancelled) {
        try {
          const q = await takePendingQuestion()
          if (cancelled || !q) continue
          pendingQuestionRef.current = q
          questionSelRef.current = 0
          questionCheckedRef.current = new Set()
          setQuestionSel(0)
          setQuestionChecked([])
          setPendingQuestion(q)
        } catch {
          // 出错继续轮询
        }
      }
    }
    void poll()
    return () => { cancelled = true }
  }, [])

  // 状态切换时刷新暴躁文案（不在渲染时调 attitudeFor 避免每次按键都变）
  useEffect(() => {
    if (running) {
      genAttitudeRef.current = attitudeFor('generating')
    } else {
      idleAttitudeRef.current = attitudeFor('idle')
    }
  }, [running])

  // v1.13: 从输入文本提取图片路径（@path 或绝对/相对路径的图片文件），读取为 image content block。
  // 支持的扩展名：png/jpg/jpeg/gif/webp/bmp。返回 [图片blocks, 去掉图片路径后的文本]。
  async function extractImages(text: string): Promise<[ContentBlock[], string]> {
    const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']
    const blocks: ContentBlock[] = []
    let cleaned = text
    // 匹配 @path/to/img.png 或 路径以图片扩展名结尾
    // 先找 @path 形式
    const atPattern = /@(\/[^\s@]+|[\w./-]+)\.(png|jpe?g|gif|webp|bmp)/gi
    let match: RegExpExecArray | null
    const foundPaths = new Set<string>()
    while ((match = atPattern.exec(text)) !== null) {
      foundPaths.add(match[0].slice(1)) // 去掉 @
    }
    // 再找裸路径（不含 @，但以图片扩展名结尾，且像文件路径）
    const barePattern = /(^|\s)((?:\/[\w./-]+)|(?:\.{0,2}\/[\w./-]+)|(?:[\w-]+\/[\w./-]+))\.(png|jpe?g|gif|webp|bmp)/gi
    while ((match = barePattern.exec(text)) !== null) {
      foundPaths.add(match[2]!)
    }
    for (const relPath of foundPaths) {
      const abs = resolve(process.cwd(), relPath)
      try {
        const buf = await readFile(abs)
        const ext = relPath.toLowerCase().match(/\.(\w+)$/)?.[1] ?? 'png'
        const mediaType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') },
        })
        // 从文本里移除该路径（避免重复传给模型）
        cleaned = cleaned.replace(new RegExp('@?' + relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '').trim()
      } catch {
        // 文件不存在/读失败跳过（保留原文本）
      }
    }
    return [blocks, blocks.length > 0 ? cleaned : text]
  }

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
    thinkingTextRef.current = ''
    thinkingShownRef.current = false
    toolBatchRef.current = []

    // 深度比对修复 #7: flush 工具 batch 为单条折叠消息
    const flushToolBatch = () => {
      const batch = toolBatchRef.current
      if (batch.length === 0) return
      toolBatchRef.current = []
      const summary = batch.map((b) => {
        const icon = b.status === 'ok' ? '[ OK ]' : b.status === 'fail' ? '[FAIL]' : '[ .. ]'
        return `  ${icon} ${b.tool}`
      }).join('\n')
      const header = batch.length === 1 ? '' : ` (${batch.length} 个工具调用)`
      setHistory((h) => [
        ...h,
        { role: 'assistant' as const, text: `${header}\n${summary}` },
        { role: 'assistant' as const, text: '' },
      ])
    }

    // 立即新增 user + 空 assistant 两条消息
    // v1.13: 提取图片路径 → image content block
    const [images, textNoImg] = await extractImages(text)
    const displayText = images.length > 0 ? `${textNoImg} [附带 ${images.length} 张图片]` : text
    setHistory((h) => [
      ...h,
      { role: 'user', text: displayText },
      { role: 'assistant', text: '' },
    ])

    try {
      for await (const event of queryLoop({
        history: chatHistoryRef.current,
        userInput: textNoImg,
        ...(images.length > 0 ? { userImages: images } : {}),
        model: config.model,
        system: await buildSystemPrompt({ tools: getAllTools() }),
        maxTokens: config.maxTokens,
        signal: ac.signal,
        apiKey: config.apiKey,
        ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
        ...(config.provider ? { provider: config.provider } : {}),
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
            // 深度比对修复 #7: flush 工具 batch（模型开始输出正文了，工具调用结束）
            flushToolBatch()
            // 深度比对修复 #3: 流式渲染节流——16ms 攒批后更新（避免每 token setState 卡顿）
            // 用 ref 记录"脏"标记，requestAnimationFrame 合并
            if (!flushTimerRef.current) {
              flushTimerRef.current = setTimeout(() => {
                flushTimerRef.current = null
                const snapshot = assistantText
                setHistory((h) => {
                  const copy = [...h]
                  copy[copy.length - 1] = { role: 'assistant' as const, text: snapshot }
                  return copy
                })
              }, 32) // ~30fps 足够流畅
            }
            break
          case 'thinking_delta': {
            // v1.19: thinking 折叠显示——首次 push 折叠态消息，后续只更新 thinkingText 字段（不刷屏全文）
            thinkingTextRef.current += event.text
            if (!thinkingShownRef.current) {
              thinkingShownRef.current = true
              // push 一条 kind:'thinking' 折叠消息
              setHistory((h) => [...h, {
                role: 'assistant' as const,
                text: `▸ 思考过程(0 字)`,
                kind: 'thinking',
                thinkingText: '',
                expanded: false,
              }])
            }
            // 节流更新折叠态的字数（不把全文刷到屏幕，避免刷屏）
            if (!flushTimerRef.current) {
              flushTimerRef.current = setTimeout(() => {
                flushTimerRef.current = null
                const snapshot = thinkingTextRef.current
                setHistory((h) => {
                  const copy = [...h]
                  // 找最后一条 thinking 消息更新字数 + thinkingText（折叠态保留全文供展开）
                  for (let j = copy.length - 1; j >= 0; j--) {
                    if (copy[j]?.kind === 'thinking') {
                      const expanded = copy[j]!.expanded ?? false
                      copy[j] = {
                        ...copy[j]!,
                        thinkingText: snapshot,
                        text: expanded ? snapshot : `▸ 思考过程(${snapshot.length} 字) 按 t 展开`,
                      }
                      break
                    }
                  }
                  return copy
                })
              }, 200)
            }
            break
          }
          case 'tool_use_start': {
            // 深度比对修复 #7: 聚合到 batch ref，不单独 push 消息
            const inputStr = JSON.stringify(event.input) ?? ''
            const summary = inputStr.slice(0, 60)
            // v1.18: 存 toolUseId 用于并发工具进度精确匹配
            toolBatchRef.current.push({ tool: `${toolTag(event.tool)} ${summary}`, status: 'running', ...(event.toolUseId ? { id: event.toolUseId } : {}) })
            // v1.19: Task 子 agent —— 提取 description 到状态栏
            if (event.tool === 'Task' && event.input && typeof event.input === 'object') {
              const desc = (event.input as { description?: string }).description
              if (desc) {
                const next = [...subagentDescsRef.current, desc]
                subagentDescsRef.current = next
                setSubagentDescs(next)
              }
            }
            break
          }
          case 'tool_progress': {
            // 深度比对第 53 轮: Bash 长命令实时进度（对标 Claude Code ShellProgressMessage）
            // v1.18: 有 toolUseId 时按 id 精确匹配（并发工具），否则回退到最后一个 running
            const batch = toolBatchRef.current
            let targetIdx = -1
            if (event.toolUseId) {
              targetIdx = batch.findIndex((b) => b.id === event.toolUseId && b.status === 'running')
            }
            if (targetIdx === -1) {
              for (let j = batch.length - 1; j >= 0; j--) {
                if (batch[j]?.status === 'running') { targetIdx = j; break }
              }
            }
            if (targetIdx >= 0) {
              const lastLines = event.lines.filter(Boolean).slice(-2).join('\n    ')
              const dur = event.elapsedMs < 1000 ? `${event.elapsedMs}ms` : `${(event.elapsedMs / 1000).toFixed(0)}s`
              batch[targetIdx] = {
                tool: `${batch[targetIdx]!.tool}\n    [${dur} · ${event.totalLines} 行] ${lastLines}`,
                status: 'running',
                ...(batch[targetIdx]!.id ? { id: batch[targetIdx]!.id } : {}),
              }
            }
            break
          }
          case 'tool_result': {
            // 更新 batch 里最后一个 running 的同工具为 ok/fail
            const batch = toolBatchRef.current
            for (let j = batch.length - 1; j >= 0; j--) {
              if (batch[j]?.status === 'running') {
                batch[j] = { tool: batch[j]!.tool, status: event.ok ? 'ok' : 'fail' }
                break
              }
            }
            // v1.19: Task 完成时从状态栏清除（FIFO，并发下移除最早一个）
            if (event.tool === 'Task' && subagentDescsRef.current.length > 0) {
              const next = subagentDescsRef.current.slice(1)
              subagentDescsRef.current = next
              setSubagentDescs(next)
            }
            break
          }
          case 'permission_request': {
            // 深度比对修复 #5: always-allow 检查（已记住的工具直接放行）
            if (alwaysAllowRef.current.has(event.tool)) {
              event.resolve('allow')
              break
            }
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
            // 深度比对修复 #7: turn_end 时 flush 残留工具 batch
            flushToolBatch()
            if (event.stopReason !== 'tool_use') {
              // 最终轮：把本轮对话存入 chatHistoryRef
              historyMgrRef.recordTurn(text, assistantText)
              chatHistoryRef.current = historyMgrRef.getChat()
            } else {
              // 工具调用中间轮：重置文本累积状态，防止下一轮 text_delta 接着本轮文本
              // 往后追加（导致"回复无限累积重复"——每轮把前面所有轮的文本重复一遍）
              assistantText = ''
              thinkingTextRef.current = ''
              thinkingShownRef.current = false
              // 给下一轮的文本累积 push 一条新的空 assistant 消息
              setHistory((h) => [...h, { role: 'assistant' as const, text: '' }])
            }
            break
          case 'aborted':
            if (assistantText) {
              historyMgrRef.recordTurn(text, assistantText + ' [已中断]')
              chatHistoryRef.current = historyMgrRef.getChat()
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
      // 流式节流兜底：确保最后的文本不丢
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
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
        ...(config.provider ? { provider: config.provider } : {}),
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
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      setRunning(false)
      abortRef.current = null
      // 深度比对第 30 轮: 计划文件持久化
      if (planText.trim()) {
        try {
          const { savePlan } = await import('@/agent/planPrompt.js')
          const planPath = await savePlan(process.cwd(), requirement, planText)
          setHistory((h) => [...h, {
            role: 'assistant' as const,
            text: `\n---\n计划已保存: ${planPath}\n执行：/workflow ${requirement} 或直接对话实施`,
          }])
        } catch { void 0 }
      }
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
        ...(config.provider ? { provider: config.provider } : {}),
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
      // 流式节流兜底：确保最后的文本不丢
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
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
        ...(config.provider ? { provider: config.provider } : {}),
        signal: ac.signal,
        cwd: process.cwd(),
        config: {
          maxTokens: config.maxTokens,
          contextWindow: config.contextWindow,
          permissions: config.permissions,
        },
      })) {
        switch (event.type) {
          case 'workflow_stage_start': {
            // 深度比对第 31 轮: 进度计数（第 N/4 阶段）
            const stageNum = ['understand', 'implement', 'verify', 'summarize'].indexOf(event.stage) + 1
            setHistory((h) => [
              ...h,
              { role: 'assistant' as const, text: `\n--- [${stageNum}/4] ${stageLabels[event.stage]} ---\n` },
              { role: 'assistant' as const, text: '' },
            ])
            break
          }
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
      // 流式节流兜底：确保最后的文本不丢
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      setRunning(false)
      abortRef.current = null
    }
  }

  // v1.6: /rewind 列出/恢复文件 checkpoint（Edit/Write 前自动备份）
  // v1.13: 增强——支持对话回滚（/rewind conv <序号>，复用会话快照机制）
  async function handleRewindCommand(text: string): Promise<void> {
    const parts = text.split(/\s+/)
    // v1.13: /rewind conv <N> 回滚对话到第 N 个快照
    if (parts[1] === 'conv' || parts[1] === 'chat') {
      if (!sessionId) {
        setHistory((h) => [...h, { role: 'assistant' as const, text: '[FAIL] 无活跃会话' }])
        return
      }
      try {
        const { listSnapshots, restoreSnapshot } = await import('@/services/SessionSnapshot.js')
        const snaps = await listSnapshots(sessionId, process.cwd())
        const idx = parts[2] ? parseInt(parts[2]) - 1 : NaN
        if (isNaN(idx)) {
          // 列出对话快照
          if (snaps.length === 0) {
            setHistory((h) => [...h, { role: 'assistant' as const, text: '没有对话快照。用 /snapshot <标签> 手动创建快照后再 /rewind conv <序号>' }])
          } else {
            const list = snaps.slice(0, 10).map((s, i) =>
              `${i + 1}. ${s.label}（${new Date(s.createdAt).toLocaleString('zh-CN')}）`,
            ).join('\n')
            setHistory((h) => [...h, { role: 'assistant' as const, text: `对话快照：\n${list}\n\n输入 /rewind conv <序号> 恢复对话到该快照` }])
          }
          return
        }
        const target = snaps[idx]
        if (!target) {
          setHistory((h) => [...h, { role: 'assistant' as const, text: `[FAIL] 无效序号（共 ${snaps.length} 个对话快照）` }])
          return
        }
        const msgs = await restoreSnapshot(target)
        // 深度比对修复: 同步 historyMgrRef（与 /resume 一致），否则 UI 渲染源与实际 messages 分裂
        historyMgrRef.restore(msgs)
        chatHistoryRef.current = historyMgrRef.getChat()
        setHistory((h) => [...h, { role: 'assistant' as const, text: `[ OK ] 对话已回滚到快照: ${target.label}（${msgs.length} 条消息）` }])
      } catch (e) {
        setHistory((h) => [...h, { role: 'assistant' as const, text: `[FAIL] 对话回滚失败: ${String(e)}` }])
      }
      return
    }

    const idx = parts[1] ? parseInt(parts[1]) - 1 : NaN
    const checkpoints = await listCheckpoints(process.cwd())
    if (checkpoints.length === 0) {
      setHistory((h) => [...h, { role: 'assistant' as const, text: '没有可回滚的文件 checkpoint（Edit/Write 改文件时会自动创建）。\n\n对话回滚：/rewind conv <序号>' }])
      return
    }
    // 无序号：列出最近的文件 checkpoint + 提示对话回滚
    if (isNaN(idx)) {
      const recent = checkpoints.slice(0, 10)
      const list = recent.map((c, i) => {
        const time = new Date(c.timestamp).toLocaleString('zh-CN')
        const shortPath = c.originalPath.replace(process.cwd() + '/', '')
        return `${i + 1}. ${shortPath}（${time}，${c.size}B）`
      }).join('\n')
      setHistory((h) => [...h, { role: 'assistant' as const, text: `最近的文件 checkpoint：\n${list}\n\n输入 /rewind <序号> 恢复文件\n输入 /rewind conv 查看对话快照（回滚对话）` }])
      return
    }
    // 有序号：恢复文件
    const target = checkpoints[idx]
    if (!target) {
      setHistory((h) => [...h, { role: 'assistant' as const, text: `无效序号（共 ${checkpoints.length} 个，最近 10 个可回滚）` }])
      return
    }
    const ok = await restoreCheckpoint(process.cwd(), target.id)
    setHistory((h) => [...h, { role: 'assistant' as const, text: ok ? `[ OK ] 已恢复 ${target.originalPath}` : `[FAIL] 恢复失败` }])
  }

  // v1.12: /skills 查看已有 skill + 创建引导
  async function handleSkillsCommand(text: string): Promise<void> {
    const skills = await loadSkills(process.cwd())
    if (text === '/skills') {
      if (skills.length === 0) {
        setHistory((h) => [...h, { role: 'assistant' as const, text: `还没有 skill。

怎么创建 skill：
  1. 建 .fuckcode/skills/<名字>/SKILL.md
  2. 写 frontmatter + 内容，格式如下：

  ---
  name: vue-debug
  description: Vue3 组件调试技巧
  effort: high
  ---

  # Vue 调试
  这里写详细的知识/指令/流程...

  3. 重启或对话，模型会自动发现并在需要时用 Skill 工具加载

skill 目录兼容：
  .fuckcode/skills/  ← fuckcode 原生
  .claude/skills/    ← 兼容 Claude Code
  .agents/skills/    ← 兼容 Codex` }])
        return
      }
      const list = skills.map((s) => {
        const tag = s.effort ? ` [${s.effort}]` : ''
        return `  ${s.name}${tag}\n    ${s.description}`
      }).join('\n')
      setHistory((h) => [...h, { role: 'assistant' as const, text: `已加载 ${skills.length} 个 skill：

${list}

模型在对话中会自动判断是否需要某个 skill，用 Skill 工具加载详细内容。` }])
      return
    }
    // /skills create <名字>
    if (text.startsWith('/skills create ')) {
      const name = text.slice('/skills create '.length).trim()
      if (!name) {
        setHistory((h) => [...h, { role: 'assistant' as const, text: '用法：/skills create <skill名字>' }])
        return
      }
      const targetDir = resolve(process.cwd(), '.fuckcode', 'skills', name)
      await mkdir(targetDir, { recursive: true })
      const targetFile = resolve(targetDir, 'SKILL.md')
      const template = `---
name: ${name}
description: 一句话描述这个 skill 干什么
effort: medium
---

# ${name}

在这里写详细的知识/指令/流程。

模型会在判断需要时自动用 Skill 工具加载这个文件的内容。
所以这里写的东西要具体、可操作——像给一个新手的操作手册。`
      await writeFile(targetFile, template, 'utf8')
      setHistory((h) => [...h, { role: 'assistant' as const, text: `[ OK ] 已创建 ${targetFile}
编辑它写入 skill 内容，下次对话自动加载。` }])
    }
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
    // v1.18: 同时推送结构化仪表盘（条形图可视化）
    setHistory((h) => [...h, {
      role: 'assistant' as const,
      text: '',
      kind: 'dashboard',
      tokens: { total, contextWindow, user: userTokens, assistant: assistantTokens, toolResult: toolResultTokens },
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
    // v1.18: 结构化 diff 数据（供 DiffViewer 渲染）
    const diffEntries: { file: string; stats: string; lines: ReturnType<typeof diffText> }[] = []
    for (const [filePath, cp] of byFile) {
      try {
        const oldContent = await readFile(cp.checkpointPath, 'utf8')
        const newContent = await readFile(filePath, 'utf8').catch(() => '(文件已删除)')
        const d = diffText(oldContent, newContent)
        const shortPath = filePath.replace(process.cwd() + '/', '')
        const stats = d.filter((l) => l.type === 'add').length + ' 增 / ' + d.filter((l) => l.type === 'del').length + ' 删'
        diffs.push(`### ${shortPath}（${stats}）\n${formatDiff(d, 2)}`)
        diffEntries.push({ file: shortPath, stats, lines: d.slice(0, 50) })
      } catch {
        // checkpoint 读失败跳过
      }
    }
    setHistory((h) => [...h, { role: 'assistant' as const, text: `本会话改动（${byFile.size} 个文件）：\n\n${diffs.join('\n\n').slice(0, 5000)}` }])
    // v1.18: 推送结构化 diff viewer（彩色高亮）
    if (diffEntries.length > 0) {
      setHistory((h) => [...h, { role: 'assistant' as const, text: '', kind: 'diff', diffs: diffEntries }])
    }
  }

  // v1.13: /compact 手动触发上下文压缩（复刻 queryLoop autoCompact 逻辑）
  async function handleCompactCommand(): Promise<void> {
    if (!sessionId) {
      setHistory((h) => [...h, { role: 'assistant' as const, text: '[FAIL] 无活跃会话，无法压缩（需先发一条消息建立会话）' }])
      return
    }
    const config = configRef.current
    const messages = chatHistoryRef.current
    if (messages.length === 0) {
      setHistory((h) => [...h, { role: 'assistant' as const, text: '当前无对话上下文，无需压缩' }])
      return
    }
    const beforeTokens = estimateMessagesTokens(messages)
    setHistory((h) => [...h, { role: 'assistant' as const, text: '[ .. ] 正在压缩上下文…' }])
    try {
      const { compactConversation } = await import('@/agent/compact.js')
      const { writeCompactBoundary } = await import('@/services/Session.js')
      const ac = new AbortController()
      const summary = await compactConversation(messages, {
        model: config?.model ?? currentModel,
        ...(config?.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config?.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
        signal: ac.signal,
      }).catch(() => '')
      // 写 boundary 到磁盘
      await writeCompactBoundary(sessionId, process.cwd(), summary).catch(() => {})
      // 替换内存 messages 为单条 boundary message（与 queryLoop 内部一致）
      const boundaryText = `<compact>之前对话的摘要:\n${summary}</compact>`
      chatHistoryRef.current = [{
        role: 'user',
        content: [{
          type: 'text',
          text: boundaryText,
          _meta: { compactBoundary: true },
        } as ContentBlock & { _meta: { compactBoundary: boolean } }],
      }]
      const afterTokens = estimateTokens(summary)
      setHistory((h) => [...h, {
        role: 'assistant' as const,
        text: `[ OK ] 上下文已压缩：${beforeTokens} → ${afterTokens} tokens（省 ${beforeTokens - afterTokens}）\n\n${summary.slice(0, 500)}${summary.length > 500 ? '...' : ''}`,
      }])
    } catch (e) {
      setHistory((h) => [...h, { role: 'assistant' as const, text: `[FAIL] 压缩失败: ${String(e)}` }])
    }
  }

  // v1.13: /memory 查看/增删记忆
  async function handleMemoryCommand(args: string): Promise<void> {
    const { loadMemories, saveMemory, deleteMemory } = await import('@/instruction/memory.js')
    const cwd = process.cwd()
    if (args.startsWith('add ')) {
      // /memory add <name> <type> <content>
      const rest = args.slice(4).trim()
      // 解析：name（第一词） type（第二词） content（剩余）
      const sp1 = rest.indexOf(' ')
      if (sp1 === -1) {
        setHistory((h) => [...h, { role: 'assistant' as const, text: '用法：/memory add <name> <type> <content>\ntype: preference/project/feedback/reference' }])
        return
      }
      const name = rest.slice(0, sp1)
      const rest2 = rest.slice(sp1 + 1).trim()
      const sp2 = rest2.indexOf(' ')
      if (sp2 === -1) {
        setHistory((h) => [...h, { role: 'assistant' as const, text: '用法：/memory add <name> <type> <content>' }])
        return
      }
      const type = rest2.slice(0, sp2).trim() as 'preference' | 'project' | 'feedback' | 'reference'
      const content = rest2.slice(sp2 + 1).trim()
      const validTypes = ['preference', 'project', 'feedback', 'reference']
      if (!validTypes.includes(type)) {
        setHistory((h) => [...h, { role: 'assistant' as const, text: `[FAIL] 无效 type: ${type}（可选: ${validTypes.join('/')}）` }])
        return
      }
      const path = await saveMemory(cwd, name, '', type, content)
      setHistory((h) => [...h, { role: 'assistant' as const, text: `[ OK ] 记忆已保存: ${name} (${type})\n${path}` }])
      return
    }
    if (args.startsWith('delete ')) {
      const name = args.slice(7).trim()
      const deleted = await deleteMemory(cwd, name)
      setHistory((h) => [...h, { role: 'assistant' as const, text: deleted ? `[ OK ] 已删除记忆: ${name}` : `[FAIL] 记忆不存在: ${name}` }])
      return
    }
    // 无参：列出所有记忆
    const memories = await loadMemories(cwd)
    if (memories.length === 0) {
      setHistory((h) => [...h, { role: 'assistant' as const, text: '没有记忆。添加：/memory add <name> <type> <content>' }])
      return
    }
    const typeLabel: Record<string, string> = { preference: '偏好', project: '项目', feedback: '反馈', reference: '参考' }
    const list = memories.map((m, i) =>
      `  ${i + 1}. [${typeLabel[m.type] ?? m.type}] ${m.name}\n     ${m.description || m.content.slice(0, 60)}`,
    ).join('\n')
    setHistory((h) => [...h, { role: 'assistant' as const, text: `记忆列表（${memories.length} 条）：\n\n${list}\n\n删除：/memory delete <name>` }])
  }

  // v1.13: /hooks 查看 hook 配置
  async function handleHooksCommand(): Promise<void> {
    const { loadHooks } = await import('@/hooks/HookManager.js')
    const cwd = process.cwd()
    const hooksFile = await loadHooks(cwd)
    const hooks = hooksFile.hooks ?? {}
    const eventNames: Array<'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart'> = [
      'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart',
    ]
    const lines: string[] = []
    for (const ev of eventNames) {
      const list = hooks[ev] ?? []
      if (list.length === 0) continue
      const note = ev === 'SessionStart' ? '（会话启动时触发）' : ''
      lines.push(`【${ev}】${note}`)
      for (const h of list) {
        lines.push(`  • matcher: ${h.matcher ?? '*'}  timeout: ${h.timeout ?? 10000}ms`)
        lines.push(`    command: ${h.command}`)
      }
    }
    if (lines.length === 0) {
      setHistory((h) => [...h, { role: 'assistant' as const, text: '没有配置 hook（.fuckcode/hooks.json）。\n\nhook 格式见文档：每条 { matcher, command, timeout }' }])
      return
    }
    setHistory((h) => [...h, { role: 'assistant' as const, text: `Hook 配置：\n\n${lines.join('\n')}` }])
  }

  // v1.13: /status 一屏状态汇总
  async function handleStatusCommand(): Promise<void> {
    const config = configRef.current
    const tokens = totalTokensRef.current
    const contextUsed = estimateMessagesTokens(chatHistoryRef.current)
    const contextWindow = config?.contextWindow ?? 200000
    const contextPct = Math.round((contextUsed / contextWindow) * 100)
    const lines = [
      `  模型：${currentModel}`,
      `  权限模式：${config?.permissionMode ?? 'default'}`,
      `  上下文：${contextUsed} / ${contextWindow} tokens（${contextPct}%）`,
      `  累计用量：输入 ${tokens.input} / 输出 ${tokens.output} / 缓存读 ${tokens.cacheRead}`,
      `  会话 ID：${sessionId ?? '(无)'}`,
      `  工作目录：${process.cwd()}`,
    ]
    // MCP 状态
    try {
      const { getMcpConnections, isMcpInitialized } = await import('@/mcp/McpState.js')
      const conns = getMcpConnections()
      if (isMcpInitialized()) {
        lines.push(`  MCP：${conns.length} 个 server${conns.length > 0 ? '（' + conns.map((c) => `${c.name}(${c.tools.length})`).join(', ') + '）' : ''}`)
      }
    } catch { /* McpState 不可用忽略 */ }
    setHistory((h) => [...h, { role: 'assistant' as const, text: `运行状态：\n\n${lines.join('\n')}` }])
  }

  // v1.13: /doctor 环境诊断
  async function handleDoctorCommand(): Promise<void> {
    const { stat } = await import('node:fs/promises')
    const { resolve } = await import('node:path')
    const cwd = process.cwd()
    const config = configRef.current
    const checks: string[] = []
    const ok = (label: string, detail = '') => checks.push(`  ✅ ${label}${detail ? ' — ' + detail : ''}`)
    const warn = (label: string, detail = '') => checks.push(`  ⚠ ${label}${detail ? ' — ' + detail : ''}`)
    const fail = (label: string, detail = '') => checks.push(`  ❌ ${label}${detail ? ' — ' + detail : ''}`)

    // apiKey
    if (config?.apiKey) ok('API Key 已配置')
    else fail('API Key 未配置', '无法调用 LLM，配置 ~/.fuckcode/config.json 的 apiKey')
    // apiBaseUrl
    if (config?.apiBaseUrl) ok('API Base URL', config.apiBaseUrl)
    // Bun 版本
    ok('Bun', `v${Bun.version}`)
    // TTY
    if (process.stdin.isTTY) ok('交互式终端 (TTY)')
    else warn('非 TTY 环境', 'headless 模式可用 -p flag')
    // .fuckcode 目录
    const fcDir = resolve(cwd, '.fuckcode')
    try { await stat(fcDir); ok('.fuckcode 目录存在') } catch { warn('.fuckcode 目录不存在', '某些功能（会话/MCP/memory）会按需创建') }
    // AGENTS.md
    for (const f of ['AGENTS.md', 'CLAUDE.md']) {
      try { await stat(resolve(cwd, f)); ok(`${f} 存在`); break } catch { /* continue */ }
    }
    // MCP 配置
    try {
      const { loadMcpConfig } = await import('@/mcp/McpClient.js')
      const mc = await loadMcpConfig(cwd)
      const count = mc.mcpServers ? Object.keys(mc.mcpServers).length : 0
      if (count > 0) {
        const { getMcpConnections } = await import('@/mcp/McpState.js')
        const connected = getMcpConnections().length
        ok('MCP', `${count} 个配置，${connected} 个已连接`)
      } else {
        warn('无 MCP 配置', '.fuckcode/mcp.json 不存在或为空')
      }
    } catch { warn('MCP 配置读取失败') }

    setHistory((h) => [...h, { role: 'assistant' as const, text: `环境诊断：\n\n${checks.join('\n')}` }])
  }

  // v1.13: /review 对本会话改动做代码审查
  async function handleReviewCommand(): Promise<void> {
    const checkpoints = await listCheckpoints(process.cwd())
    if (checkpoints.length === 0) {
      setHistory((h) => [...h, { role: 'assistant' as const, text: '没有改动记录。用 Edit/Write 改完文件后再 /review' }])
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
        diffs.push(`### ${shortPath}\n${formatDiff(d, 3)}`)
      } catch { /* skip */ }
    }
    const diffTextAll = diffs.join('\n\n').slice(0, 12000)
    setHistory((h) => [...h, { role: 'assistant' as const, text: '[ .. ] 正在审查改动…' }])
    try {
      const { streamMessage } = await import('@/llm/provider.js')
      const config = configRef.current
      const ac = new AbortController()
      let review = ''
      for await (const event of streamMessage({
        model: config?.model ?? currentModel,
        system: '你是严格的代码审查员。审查以下 git diff，找出：bug、安全问题、性能问题、风格问题、改进建议。按"严重/建议"分类，每条给文件+行号。简洁直接，不寒暄。',
        messages: [{ role: 'user', content: `请审查这些改动：\n\n${diffTextAll}` }],
        signal: ac.signal,
        ...(config?.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config?.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
        ...(config?.provider ? { provider: config.provider } : {}),
      })) {
        if (event.type === 'text') review += event.textDelta
      }
      setHistory((h) => [...h, { role: 'assistant' as const, text: `代码审查结果：\n\n${review || '(无输出)'}` }])
    } catch (e) {
      setHistory((h) => [...h, { role: 'assistant' as const, text: `[FAIL] 审查失败: ${String(e)}` }])
    }
  }

  // v1.13: /mcp 查看/管理 MCP server
  async function handleMcpCommand(args: string): Promise<void> {
    const { getMcpConnections, findMcpConnection, removeMcpConnection, upsertMcpConnection } = await import('@/mcp/McpState.js')
    const { disconnectOne, reconnectOne, loadMcpConfig, checkConnectionHealth } = await import('@/mcp/McpClient.js')
    const cwd = process.cwd()

    if (args.startsWith('tools ')) {
      const name = args.slice(6).trim()
      const conn = findMcpConnection(name)
      if (!conn) {
        setHistory((h) => [...h, { role: 'assistant' as const, text: `[FAIL] 未连接 server: ${name}` }])
        return
      }
      const list = conn.tools.map((t) => `  • ${t.name}`).join('\n')
      setHistory((h) => [...h, { role: 'assistant' as const, text: `${name} 的工具（${conn.tools.length} 个）：\n${list}` }])
      return
    }
    if (args.startsWith('disconnect ')) {
      const name = args.slice(11).trim()
      const conns = getMcpConnections()
      const ok = await disconnectOne(conns, name)
      if (ok) { removeMcpConnection(name); setHistory((h) => [...h, { role: 'assistant' as const, text: `[ OK ] 已断开 ${name}` }]) }
      else { setHistory((h) => [...h, { role: 'assistant' as const, text: `[FAIL] 未找到 server: ${name}` }]) }
      return
    }
    if (args.startsWith('reconnect ')) {
      const name = args.slice(10).trim()
      setHistory((h) => [...h, { role: 'assistant' as const, text: `[ .. ] 正在重连 ${name}…` }])
      try {
        const mc = await loadMcpConfig(cwd)
        const conn = await reconnectOne(mc, name)
        upsertMcpConnection(conn)
        setHistory((h) => [...h, { role: 'assistant' as const, text: `[ OK ] 已重连 ${name}（${conn.tools.length} 个工具）` }])
      } catch (e) {
        setHistory((h) => [...h, { role: 'assistant' as const, text: `[FAIL] 重连失败: ${String(e)}` }])
      }
      return
    }
    // 无参：列出连接状态（含健康探活）
    const conns = getMcpConnections()
    if (conns.length === 0) {
      setHistory((h) => [...h, { role: 'assistant' as const, text: '没有已连接的 MCP server。\n配置 .fuckcode/mcp.json 后重启，或 /mcp reconnect <name>' }])
      return
    }
    const lines: string[] = []
    for (const conn of conns) {
      const health = await checkConnectionHealth(conn)
      const icon = health === 'connected' ? '✅' : '❌'
      lines.push(`  ${icon} ${conn.name}（${conn.tools.length} 个工具）`)
    }
    setHistory((h) => [...h, { role: 'assistant' as const, text: `MCP server（${conns.length} 个）：\n\n${lines.join('\n')}\n\n管理：/mcp reconnect <name> | /mcp disconnect <name> | /mcp tools <name>` }])
  }

  // v1.13: /permissions 查看/修改权限规则
  async function handlePermissionsCommand(args: string): Promise<void> {
    const config = configRef.current
    if (!config) {
      setHistory((h) => [...h, { role: 'assistant' as const, text: '[FAIL] 配置未加载' }])
      return
    }
    const { saveConfig } = await import('@/services/Config.js')

    if (args.startsWith('mode ')) {
      const mode = args.slice(5).trim() as typeof config.permissionMode
      const valid = ['default', 'acceptEdits', 'plan', 'bypassPermissions']
      if (!valid.includes(mode)) {
        setHistory((h) => [...h, { role: 'assistant' as const, text: `[FAIL] 无效模式。可选: ${valid.join('/')}` }])
        return
      }
      config.permissionMode = mode
      await saveConfig({ permissionMode: mode }, 'user').catch((e: unknown) => setHistory((h) => [...h, { role: 'assistant' as const, text: `⚠ 持久化失败: ${String(e)}` }]))
      setHistory((h) => [...h, { role: 'assistant' as const, text: `[ OK ] 权限模式 = ${mode}（已持久化）` }])
      return
    }
    if (args.startsWith('add ')) {
      // /permissions add <allow|ask|deny> <规则>
      const rest = args.slice(4).trim()
      const sp = rest.indexOf(' ')
      if (sp === -1) {
        setHistory((h) => [...h, { role: 'assistant' as const, text: '用法：/permissions add <allow|ask|deny> <规则>' }])
        return
      }
      const group = rest.slice(0, sp).trim()
      const rule = rest.slice(sp + 1).trim()
      const arr = group === 'allow' ? config.permissions.allow : group === 'ask' ? config.permissions.ask : group === 'deny' ? config.permissions.deny : null
      if (!arr) {
        setHistory((h) => [...h, { role: 'assistant' as const, text: `[FAIL] 无效组: ${group}（可选 allow/ask/deny）` }])
        return
      }
      arr.push(rule)
      await saveConfig({ permissions: config.permissions }, 'user').catch(() => {})
      setHistory((h) => [...h, { role: 'assistant' as const, text: `[ OK ] 已添加 ${group} 规则: ${rule}` }])
      return
    }
    if (args.startsWith('remove ')) {
      // /permissions remove <allow|ask|deny> <序号>
      const rest = args.slice(7).trim()
      const sp = rest.indexOf(' ')
      if (sp === -1) {
        setHistory((h) => [...h, { role: 'assistant' as const, text: '用法：/permissions remove <allow|ask|deny> <序号>' }])
        return
      }
      const group = rest.slice(0, sp).trim()
      const idx = parseInt(rest.slice(sp + 1)) - 1
      const arr = group === 'allow' ? config.permissions.allow : group === 'ask' ? config.permissions.ask : group === 'deny' ? config.permissions.deny : null
      if (!arr || idx < 0 || idx >= arr.length) {
        setHistory((h) => [...h, { role: 'assistant' as const, text: `[FAIL] 无效组或序号` }])
        return
      }
      const removed = arr.splice(idx, 1)[0]
      await saveConfig({ permissions: config.permissions }, 'user').catch(() => {})
      setHistory((h) => [...h, { role: 'assistant' as const, text: `[ OK ] 已删除 ${group}[${idx + 1}]: ${removed}` }])
      return
    }
    // 无参：展示当前规则
    const fmt = (label: string, arr: string[]) =>
      arr.length > 0 ? `  【${label}】\n${arr.map((r, i) => `    ${i + 1}. ${r}`).join('\n')}` : `  【${label}】（空）`
    setHistory((h) => [...h, {
      role: 'assistant' as const,
      text: `权限模式：${config.permissionMode}\n\n${fmt('allow', config.permissions.allow)}\n${fmt('ask', config.permissions.ask)}\n${fmt('deny', config.permissions.deny)}\n\n修改：/permissions add <allow|ask|deny> <规则> | /permissions remove <组> <序号> | /permissions mode <模式>`,
    }])
  }

  // v1.13: /add-dir 多目录工作区
  async function handleAddDirCommand(args: string): Promise<void> {
    const { addExtraDir, getExtraDirs } = await import('@/tools/extraDirs.js')
    if (!args) {
      const dirs = getExtraDirs()
      setHistory((h) => [...h, {
        role: 'assistant' as const,
        text: `工作目录：\n  • ${process.cwd()}（主）${dirs.length > 0 ? '' : '\n\n添加：/add-dir <路径>'}${dirs.map((d, i) => `\n  ${i + 1}. ${d}`).join('')}`,
      }])
      return
    }
    const abs = addExtraDir(args)
    extraDirsRef.current.add(abs)
    setHistory((h) => [...h, { role: 'assistant' as const, text: `[ OK ] 已添加工作目录: ${abs}\n（Glob/Grep 将跨目录搜索；共 ${getExtraDirs().length + 1} 个目录）` }])
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
    // 深度比对第 66 轮: effort 覆盖（对标 Claude Code/opencode skill effort）
    if (cmd.effort) {
      // effort 存到 configRef 供 streamAnthropic 使用（future: 透传到 API）
      if (configRef.current) (configRef.current as Record<string, unknown>).effort = cmd.effort
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
        setCursorOffset(0)
        setCursorOffset(0)
      return true
    }
    // 深度比对第 17 轮: /resume 无参数时自动列出会话（省一步）
    if (text === '/resume') {
      // 走 /sessions 的逻辑
      return handleSessionCommand('/sessions')
    }
    if (text.startsWith('/resume ')) {
      const idx = parseInt(text.split(' ')[1] ?? '', 10) - 1
      const sessions = sessionsListRef.current
      // 如果 sessionsListRef 空，先加载
      if (sessions.length === 0) {
        const allSessions = await listSessions(process.cwd())
        sessionsListRef.current = allSessions
      }
      const currentSessions = sessionsListRef.current
      const target = Number.isNaN(idx) ? undefined : currentSessions[idx]
      if (!target) {
        setHistory((h) => [
          ...h,
          { role: 'assistant', text: `无效序号。可用会话：\n${currentSessions.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}` },
        ])
        setInput('')
        setCursorOffset(0)
        return true
      }
      const msgs = await loadMessages(target.id, process.cwd()).catch(
        () => [] as ChatMessage[],
      )
      historyMgrRef.restore(msgs)
      chatHistoryRef.current = historyMgrRef.getChat()
      setSessionId(target.id)
      setHistory((h) => [
        ...h,
        {
          role: 'assistant',
          text: `[ OK ] 已恢复会话（${msgs.length} 条消息）`,
        },
      ])
      setInput('')
        setCursorOffset(0)
        setCursorOffset(0)
      return true
    }
    return false
  }

  // refactor: 初始化命令注册中心（首次渲染时注册所有命令）
  // 替代 useInput 回车处理里的 17 个 if-else 分发
  if (!commandRegistryRef.current) {
    const reg = new CommandRegistry()

    reg.register(
      { cmd: '/exit', desc: '退出', example: '/exit' },
      () => { exit() },
      { aliases: ['/quit'] },
    )
    reg.register(
      { cmd: '/clear', desc: '清空当前上下文', example: '/clear' },
      () => {
        historyMgrRef.clearChat()
        chatHistoryRef.current = []
        setHistory([])
        setInput('')
        setCursorOffset(0)
        setCursorOffset(0)
      },
      { requiresRunning: false },
    )
    reg.register(
      { cmd: '/cost', desc: '显示 token 用量', example: '/cost' },
      () => {
        const t = totalTokensRef.current
        setHistory((h) => [...h, {
          role: 'assistant' as const,
          text: `本次会话用量：输入 ${t.input} / 输出 ${t.output} / 缓存读 ${t.cacheRead} tokens`,
        }])
        setInput('')
        setCursorOffset(0)
        setCursorOffset(0)
      },
    )
    reg.register(
      { cmd: '/model', desc: '查看或切换模型', args: '[模型名]', example: '/model gpt-4o' },
      (args) => {
        if (args) {
          setCurrentModel(args)
          if (configRef.current) configRef.current.model = args
          setHistory((h) => [...h, { role: 'assistant' as const, text: `[ OK ] 模型已切换为 ${args}（下次对话生效）` }])
        } else {
          setHistory((h) => [...h, {
            role: 'assistant' as const,
            text: `当前模型：${currentModel}\n\n切换：/model <模型名>\n常用：\n  claude-sonnet-4-5-20250929（默认）\n  claude-opus-4-1-20250805（强，贵）\n  claude-haiku-3-5（快，便宜）`,
          }])
        }
        setInput('')
        setCursorOffset(0)
        setCursorOffset(0)
      },
    )
    reg.register(
      { cmd: '/rewind', desc: '回滚文件到 checkpoint', args: '[序号]', example: '/rewind 2' },
      (args) => { void handleRewindCommand(args ? `/rewind ${args}` : '/rewind') },
      { requiresRunning: false },
    )
    reg.register(
      { cmd: '/diff', desc: '查看本次会话改动', example: '/diff' },
      () => { void handleDiffCommand() },
      { requiresRunning: false },
    )
    reg.register(
      { cmd: '/context', desc: '分析 token 占用', example: '/context' },
      () => { void handleContextCommand() },
      { requiresRunning: false },
    )
    reg.register(
      { cmd: '/skills', desc: '查看/创建 skill', args: '[create <名>]', example: '/skills create vue' },
      (args) => { void handleSkillsCommand(args ? `/skills ${args}` : '/skills') },
      { requiresRunning: false },
    )
    // 深度比对第 34 轮: /reload-skills 热重载（对标 Claude Code /reload-skills）
    reg.register(
      { cmd: '/reload-skills', desc: '重新扫描 skill/AGENTS.md 文件', example: '/reload-skills' },
      async () => {
        const { reloadCustomizations } = await import('@/agent/systemPrompt.js')
        reloadCustomizations()
        setHistory((h) => [...h, {
          role: 'assistant' as const,
          text: `[ OK ] 已重新加载 skill + AGENTS.md（下次对话生效）`,
        }])
        setInput('')
        setCursorOffset(0)
      },
      { requiresRunning: false, aliases: ['/reload'] },
    )
    reg.register(
      { cmd: '/less-perms', desc: '生成权限白名单', example: '/less-perms' },
      () => { void handleLessPermissionsCommand() },
      { requiresRunning: false, aliases: ['/less-permission-prompts'] },
    )
    reg.register(
      { cmd: '/help', desc: '显示完整帮助', example: '/help' },
      () => {
        setHistory((h) => [...h, {
          role: 'assistant' as const,
          text: `可用命令（输入 / 后实时提示）：\n\n【工作流】\n  /workflow <需求>  四阶段工作流\n  /goal <目标>      目标驱动\n  /plan <需求>      只读计划\n\n【上下文】\n  /context /diff /rewind /cost\n\n【模型】\n  /model [名] /less-perms\n\n【项目】\n  /init /agents /sessions /resume /skills /clear\n\n  /exit 退出`,
        }])
        setInput('')
        setCursorOffset(0)
        setCursorOffset(0)
      },
      { aliases: ['/?'] },
    )
    reg.register(
      { cmd: '/sessions', desc: '列出历史会话', example: '/sessions' },
      () => { void handleSessionCommand('/sessions') },
      { requiresRunning: false },
    )
    reg.register(
      { cmd: '/resume', desc: '恢复历史会话', args: '<序号>', example: '/resume 1' },
      (args) => { void handleSessionCommand(`/resume ${args}`) },
      { requiresRunning: false },
    )
    reg.register(
      { cmd: '/init', desc: '生成 AGENTS.md', example: '/init' },
      () => { void handleInstructionCommand('/init') },
      { requiresRunning: false },
    )
    reg.register(
      { cmd: '/agents', desc: '显示 AGENTS.md', example: '/agents' },
      () => { void handleInstructionCommand('/agents') },
      { requiresRunning: false, aliases: ['/instructions'] },
    )
    reg.register(
      { cmd: '/workflow', desc: '四阶段工作流', args: '<需求>', example: '/workflow 加登录' },
      (args) => { if (args) void runWorkflowTask(args) },
    )
    reg.register(
      { cmd: '/goal', desc: '目标驱动', args: '<目标>', example: '/goal 测试全过' },
      (args) => { if (args) void runGoalTask(args) },
    )
    reg.register(
      { cmd: '/plan', desc: '只读分析计划', args: '<需求>', example: '/plan 重构' },
      (args) => { if (args) void runPlan(args) },
    )
    // 深度比对第 10 轮: /config 运行时查看/修改配置
    reg.register(
      { cmd: '/config', desc: '查看或修改配置', args: '[key=value]', example: '/config model=gpt-4o' },
      async (args) => {
        const cfg = configRef.current
        if (!args) {
          // 显示当前配置
          const lines = [
            `model = ${currentModel}`,
            `maxTokens = ${cfg?.maxTokens ?? 8192}`,
            `contextWindow = ${cfg?.contextWindow ?? 200000}`,
            `permissionMode = ${cfg?.permissionMode ?? 'default'}`,
            `provider = ${cfg?.provider ?? 'auto'}`,
            `apiBaseUrl = ${cfg?.apiBaseUrl ?? '(default)'}`,
            `fallbackModels = ${cfg?.fallbackModels?.join(', ') ?? '(none)'}`,
          ]
          setHistory((h) => [...h, {
            role: 'assistant' as const,
            text: `当前配置:\n${lines.map((l) => `  ${l}`).join('\n')}\n\n修改：/config key=value（如 /config model=gpt-4o）`,
          }])
        } else {
          // 解析 key=value
          const eqIdx = args.indexOf('=')
          if (eqIdx === -1) {
            setHistory((h) => [...h, { role: 'assistant' as const, text: '用法：/config key=value（如 /config model=gpt-4o）' }])
          } else {
            const key = args.slice(0, eqIdx).trim()
            const value = args.slice(eqIdx + 1).trim()
            // 运行时修改 configRef
            if (configRef.current) {
              // v1.18: 构造 saveConfig partial（key→值，类型正确）
              let partial: Record<string, unknown> = {}
              if (key === 'model') { configRef.current.model = value; setCurrentModel(value); partial = { model: value } }
              else if (key === 'maxTokens') { configRef.current.maxTokens = parseInt(value) || 8192; partial = { maxTokens: parseInt(value) || 8192 } }
              else if (key === 'permissionMode') { configRef.current.permissionMode = value as typeof configRef.current.permissionMode; partial = { permissionMode: value } }
              else if (key === 'provider') { configRef.current.provider = value as typeof configRef.current.provider; partial = { provider: value } }
              else {
                setHistory((h) => [...h, { role: 'assistant' as const, text: `[FAIL] 未知配置项: ${key}\n可改: model / maxTokens / permissionMode / provider` }])
                return
              }
              // v1.18: 持久化到 user 级配置（与 /permissions 一致，重启不丢失）
              try {
                const { saveConfig } = await import('@/services/Config.js')
                await saveConfig(partial, 'user')
                setHistory((h) => [...h, { role: 'assistant' as const, text: `[ OK ] ${key} = ${value}（已持久化，下次对话生效）` }])
              } catch (e) {
                setHistory((h) => [...h, { role: 'assistant' as const, text: `[ OK ] ${key} = ${value}（本次生效，但持久化失败: ${String(e)}）` }])
              }
            }
          }
        }
        setInput('')
        setCursorOffset(0)
      },
    )

    // 深度比对第 55 轮: /snapshot + /export 命令（对标 opencode snapshot/revert + share）
    reg.register(
      { cmd: '/snapshot', desc: '创建/列出/恢复快照', args: '[list|restore <N>|<标签>]', example: '/snapshot 重构前' },
      async (args) => {
        if (!sessionId) {
          setHistory((h) => [...h, { role: 'assistant' as const, text: '[FAIL] 无活跃会话' }])
          setInput('')
          setCursorOffset(0)
          return
        }
        try {
          const { createSnapshot, listSnapshots, restoreSnapshot } = await import('@/services/SessionSnapshot.js')
          // 深度比对第 57 轮: /snapshot list + /snapshot restore <N>
          if (args === 'list' || !args) {
            const snaps = await listSnapshots(sessionId, process.cwd())
            if (snaps.length === 0) {
              setHistory((h) => [...h, { role: 'assistant' as const, text: '没有快照。创建：/snapshot <标签>' }])
            } else {
              const list = snaps.slice(0, 10).map((s, i) =>
                `${i + 1}. ${s.label} (${new Date(s.createdAt).toLocaleString('zh-CN')})`,
              ).join('\n')
              setHistory((h) => [...h, { role: 'assistant' as const, text: `快照列表：\n${list}\n\n恢复：/snapshot restore <序号>` }])
            }
          } else if (args.startsWith('restore ')) {
            const idx = parseInt(args.slice('restore '.length)) - 1
            const snaps = await listSnapshots(sessionId, process.cwd())
            const target = snaps[idx]
            if (!target) {
              setHistory((h) => [...h, { role: 'assistant' as const, text: `[FAIL] 无效序号（共 ${snaps.length} 个快照）` }])
            } else {
              const msgs = await restoreSnapshot(target)
              chatHistoryRef.current = msgs
              setHistory((h) => [...h, { role: 'assistant' as const, text: `[ OK ] 已恢复到快照: ${target.label}` }])
            }
          } else {
            const snap = await createSnapshot(sessionId, process.cwd(), chatHistoryRef.current, args)
            setHistory((h) => [...h, { role: 'assistant' as const, text: `[ OK ] 快照已创建: ${snap.label} (${new Date(snap.createdAt).toLocaleString('zh-CN')})` }])
          }
        } catch (e) {
          setHistory((h) => [...h, { role: 'assistant' as const, text: `[FAIL] 快照操作失败: ${String(e)}` }])
        }
        setInput('')
        setCursorOffset(0)
      },
      { requiresRunning: false },
    )
    reg.register(
      { cmd: '/export', desc: '导出会话为 markdown', args: '', example: '/export' },
      async () => {
        if (!sessionId) {
          setHistory((h) => [...h, { role: 'assistant' as const, text: '[FAIL] 无活跃会话' }])
          return
        }
        try {
          const { exportSessionMarkdown } = await import('@/services/SessionSnapshot.js')
          const md = await exportSessionMarkdown(sessionId, process.cwd())
          const { writeFile } = await import('node:fs/promises')
          const { resolve: resolvePath } = await import('node:path')
          const exportPath = resolvePath(process.cwd(), `.fuckcode/exports/${sessionId}-${Date.now()}.md`)
          await writeFile(exportPath, md, 'utf8').catch(async () => {
            const { mkdir } = await import('node:fs/promises')
            await mkdir(resolvePath(exportPath, '..'), { recursive: true })
            await writeFile(exportPath, md, 'utf8')
          })
          setHistory((h) => [...h, { role: 'assistant' as const, text: `[ OK ] 会话已导出: ${exportPath}` }])
        } catch (e) {
          setHistory((h) => [...h, { role: 'assistant' as const, text: `[FAIL] 导出失败: ${String(e)}` }])
        }
        setInput('')
        setCursorOffset(0)
      },
      { requiresRunning: false },
    )
    // 深度比对第 69 轮: /version + /release-notes（对标 Claude Code /release-notes）
    reg.register(
      { cmd: '/version', desc: '显示版本号', args: '', example: '/version' },
      () => {
        setHistory((h) => [...h, { role: 'assistant' as const, text: `fuckcode v${version}` }])
        setInput('')
        setCursorOffset(0)
      },
    )
    // v1.13: /compact 手动触发上下文压缩
    reg.register(
      { cmd: '/compact', desc: '手动压缩上下文', args: '', example: '/compact' },
      () => { void handleCompactCommand(); setInput(''); setCursorOffset(0) },
      { requiresRunning: false },
    )
    // v1.13: /memory 查看/增删记忆
    reg.register(
      { cmd: '/memory', desc: '查看/增删记忆', args: '[add|delete ...]', example: '/memory' },
      (args) => { void handleMemoryCommand(args); setInput(''); setCursorOffset(0) },
      { requiresRunning: false },
    )
    // v1.13: /hooks 查看 hook 配置
    reg.register(
      { cmd: '/hooks', desc: '查看 hook 配置', args: '', example: '/hooks' },
      () => { void handleHooksCommand(); setInput(''); setCursorOffset(0) },
      { requiresRunning: false },
    )
    // v1.13: /status 一屏状态汇总
    reg.register(
      { cmd: '/status', desc: '查看运行状态', args: '', example: '/status' },
      () => { void handleStatusCommand(); setInput(''); setCursorOffset(0) },
      { requiresRunning: false },
    )
    // v1.13: /doctor 环境诊断
    reg.register(
      { cmd: '/doctor', desc: '环境诊断', args: '', example: '/doctor' },
      () => { void handleDoctorCommand(); setInput(''); setCursorOffset(0) },
      { requiresRunning: false },
    )
    // v1.13: /review 代码审查
    reg.register(
      { cmd: '/review', desc: '代码审查', args: '', example: '/review' },
      () => { void handleReviewCommand(); setInput(''); setCursorOffset(0) },
      { requiresRunning: false },
    )
    // v1.13: /mcp 管理 MCP server
    reg.register(
      { cmd: '/mcp', desc: '查看/管理 MCP', args: '[reconnect|disconnect|tools ...]', example: '/mcp' },
      (args) => { void handleMcpCommand(args); setInput(''); setCursorOffset(0) },
      { requiresRunning: false },
    )
    // v1.13: /permissions 查看/修改权限规则
    reg.register(
      { cmd: '/permissions', desc: '查看/修改权限', args: '[add|remove|mode ...]', example: '/permissions' },
      (args) => { void handlePermissionsCommand(args); setInput(''); setCursorOffset(0) },
      { requiresRunning: false },
    )
    // v1.13: /add-dir 多目录工作区
    reg.register(
      { cmd: '/add-dir', desc: '添加工作目录', args: '[<路径>]', example: '/add-dir ../other' },
      (args) => { handleAddDirCommand(args); setInput(''); setCursorOffset(0) },
      { requiresRunning: false },
    )
    // v1.13: /emacs 显示 emacs 风格快捷键（默认全部启用，无需切换）
    reg.register(
      { cmd: '/emacs', desc: 'emacs 快捷键', args: '', example: '/emacs' },
      () => {
        setHistory((h) => [...h, {
          role: 'assistant' as const,
          text: `emacs 风格快捷键（默认全部启用）：

  Ctrl+A  行首        Ctrl+E  行尾
  Ctrl+B  左移一字符  Ctrl+F  右移一字符
  Ctrl+P  上一条历史  Ctrl+N  下一条历史
  Ctrl+U  删到行首    Ctrl+K  删到行尾
  Ctrl+W  删一个词    Ctrl+L  清屏
  ↑ / ↓   历史（多行时移动光标）`,
        }])
        setInput(''); setCursorOffset(0)
      },
      { requiresRunning: false },
    )
    // v1.18: /vim 开关 vim modal 输入模式
    reg.register(
      { cmd: '/vim', desc: '开关 vim 模式', args: '', example: '/vim' },
      () => {
        vimEnabledRef.current = !vimEnabledRef.current
        if (vimEnabledRef.current) {
          vimModeRef.current = 'insert'
          setVimIndicator('insert')
          setHistory((h) => [...h, {
            role: 'assistant' as const,
            text: `[ OK ] vim 模式已开启（输入框底部显示 -- NORMAL -- / -- INSERT --）

  insert 模式（默认）：正常打字 + emacs 快捷键
  Esc 切 normal 模式

  normal 模式键位：
  h l / ← →   左右移动
  0 / $       行首 / 行尾
  w / b       下一词 / 上一词
  i / a       光标处 / 光标后进 insert
  A / I       行尾 / 行首进 insert
  x           删光标处字符
  d           删到行尾
  Enter       提交输入

再 /vim 关闭。`,
          }])
        } else {
          vimModeRef.current = 'insert'
          setVimIndicator(null)
          setHistory((h) => [...h, { role: 'assistant' as const, text: '[ OK ] vim 模式已关闭（恢复 emacs 快捷键）' }])
        }
        setInput(''); setCursorOffset(0)
      },
      { requiresRunning: false },
    )
    // 关键:把注册好的 registry 实例赋给 ref，否则 commandRegistryRef.current 永远是 null，
    // 所有 / 命令分发会短路跳过、fallthrough 到自定义命令 → 报"未知命令"
    commandRegistryRef.current = reg
  }

  useInput((inputChar, key) => {
    // 权限弹窗激活时接管输入：只接 y/n（大小写都行），其他键忽略。
    // 读 ref 而非 state（useInput 闭包持有的是首次注册时的 state，看不到后续更新）。
    const pending = pendingPermissionRef.current
    if (pending) {
      // v1.19: 左右键切换选项（0=本次允许 1=总是允许 2=拒绝），Enter 确认
      // 保留 y/a/n 快捷键兼容老手
      const PERM_OPTIONS = 3
      if (key.leftArrow) {
        permSelRef.current = (permSelRef.current - 1 + PERM_OPTIONS) % PERM_OPTIONS
        setPermSel(permSelRef.current)
        return
      }
      if (key.rightArrow) {
        permSelRef.current = (permSelRef.current + 1) % PERM_OPTIONS
        setPermSel(permSelRef.current)
        return
      }
      const decide = (idx: number) => {
        if (idx === 0) { pending.resolve('allow') }
        else if (idx === 1) { alwaysAllowRef.current.add(pending.tool); pending.resolve('allow') }
        else { pending.resolve('deny') }
        pendingPermissionRef.current = null
        setPendingPermission(null)
        permSelRef.current = 0
        setPermSel(0)
      }
      if (key.return) { decide(permSelRef.current); return }
      // 快捷键兼容：y=本次允许 a=总是允许 n=拒绝
      if (inputChar === 'y' || inputChar === 'Y') { decide(0); return }
      if (inputChar === 'a' || inputChar === 'A') { decide(1); return }
      if (inputChar === 'n' || inputChar === 'N') { decide(2); return }
      // Ctrl+C 在弹窗中视为拒绝
      if (key.ctrl && (inputChar === 'c' || inputChar === 'd')) { decide(2); return }
      return // 其他键忽略
    }
    // v1.19: AskUserQuestion 弹窗——← → 切换、Space 多选、Enter 提交
    const pq = pendingQuestionRef.current
    if (pq) {
      const count = pq.options.length
      const submit = () => {
        const checked = questionCheckedRef.current
        const sel = questionSelRef.current
        // 单选：返回当前选中；多选：返回所有勾选（无勾选则用当前选中）
        let answers: string[]
        if (pq.multiSelect) {
          answers = checked.size > 0
            ? [...checked].sort((a, b) => a - b).map((i) => pq.options[i]?.label ?? '')
            : [pq.options[sel]?.label ?? '']
        } else {
          answers = [pq.options[sel]?.label ?? '']
        }
        pq.resolve(answers.filter(Boolean))
        pendingQuestionRef.current = null
        setPendingQuestion(null)
        questionSelRef.current = 0
        questionCheckedRef.current = new Set()
      }
      if (key.leftArrow) { questionSelRef.current = (questionSelRef.current - 1 + count) % count; setQuestionSel(questionSelRef.current); return }
      if (key.rightArrow) { questionSelRef.current = (questionSelRef.current + 1) % count; setQuestionSel(questionSelRef.current); return }
      if (key.upArrow) { questionSelRef.current = (questionSelRef.current - 1 + count) % count; setQuestionSel(questionSelRef.current); return }
      if (key.downArrow) { questionSelRef.current = (questionSelRef.current + 1) % count; setQuestionSel(questionSelRef.current); return }
      if (pq.multiSelect && inputChar === ' ') {
        const s = questionCheckedRef.current
        if (s.has(questionSelRef.current)) s.delete(questionSelRef.current)
        else s.add(questionSelRef.current)
        setQuestionChecked([...s].sort((a, b) => a - b))
        return
      }
      if (key.return) { submit(); return }
      // 数字键 1-4 直接选
      const num = parseInt(inputChar)
      if (num >= 1 && num <= count) { questionSelRef.current = num - 1; setQuestionSel(num - 1); if (!pq.multiSelect) { submit() }; return }
      return // 其他键忽略
    }
    // v1.19: 按 t 切换最近一条 thinking 消息的展开/折叠（仅输入框为空时，避免打字拦截）
    if (inputChar === 't' && input.length === 0 && !running) {
      setHistory((h) => {
        const copy = [...h]
        for (let j = copy.length - 1; j >= 0; j--) {
          if (copy[j]?.kind === 'thinking') {
            const m = copy[j]!
            const expanded = !m.expanded
            copy[j] = {
              ...m,
              expanded,
              text: expanded ? (m.thinkingText ?? '') : `▸ 思考过程(${(m.thinkingText ?? '').length} 字) 按 t 展开`,
            }
            // 展开时 text 显示全文，折叠时显示提示
            if (expanded) copy[j]!.text = `▾ 思考过程(${(m.thinkingText ?? '').length} 字) 按 t 折叠`
            break
          }
        }
        return copy
      })
      return
    }
    // v1.18: vim modal 编辑——vim 开启时接管按键
    if (vimEnabledRef.current) {
      // insert 模式：Esc 切 normal（不退出程序）；其余走下面的 emacs 逻辑
      if (vimModeRef.current === 'insert') {
        if (inputChar === '\x1b' || key.escape) {
          vimModeRef.current = 'normal'
          setVimIndicator('normal')
          // 光标回退一格（vim 习惯：离开 insert 时光标左移）
          setCursorOffset((o) => Math.max(0, o - 1))
          return
        }
        // 其他 insert 按键继续走下面的 emacs/默认逻辑
      } else {
        // normal 模式：vim 接管
        const result = handleVimNormalKey(
          { input, offset: cursorOffset, mode: 'normal' },
          inputChar,
          key,
        )
        if (result.handled) {
          if (result.submit) {
            // normal 模式回车提交
            const text = input.trim()
            if (text) {
                  // 走回车提交逻辑（复用下面的 return 分支太复杂，这里直接触发 runQuery）
              if (commandRegistryRef.current && isSlashCommand(text)) {
                const registry = commandRegistryRef.current
                void registry.tryExecute(text, running).then((handled) => {
                  if (handled) setInput('')
                  setCursorOffset(0)
                })
                if (registry.match(text).length > 0) return
              }
              void runQuery(text)
              setInput('')
              setCursorOffset(0)
            }
            return
          }
          if (result.mode) { vimModeRef.current = result.mode; setVimIndicator(result.mode) }
          if (result.input !== undefined) { setInput(result.input); setCursorOffset(result.offset ?? cursorOffset) }
          else if (result.offset !== undefined) setCursorOffset(result.offset)
          return
        }
      }
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
    // UX: Esc 清空输入
    // 深度比对第 61 轮: Esc 双击防误触（对标 Claude Code useDoublePress 300ms）
    if (inputChar === '\x1b' || key.escape) {
      // 有输入时第一次 Esc 清空输入，第二次才退出
      if (input.length > 0) {
        setInput('')
        setCursorOffset(0)
        setCmdHintIndex(0)
        // 标记"Esc 已按一次"——350ms 内再按才退出
        escPressRef.current = Date.now()
        return
      }
      // 空输入——检查是否在 350ms 内连按
      if (Date.now() - escPressRef.current < 350) {
        exit()
        return
      }
      // 第一次按——提示再按一次
      escPressRef.current = Date.now()
      setHistory((h) => [...h, { role: 'assistant' as const, text: '(再按一次 Esc 退出)' }])
      // 1 秒后清除提示标记
      setTimeout(() => { escPressRef.current = 0 }, 1000)
      return
    }
    // UX: Ctrl+L 清屏（清空显示历史，保留对话上下文）
    if (key.ctrl && inputChar === 'l') {
      setHistory([])
      setCmdHintIndex(0)
      return
    }
    // 深度比对修复 #6: Ctrl+W 删词、Ctrl+U 清行、Ctrl+K 删到行尾
    // 深度比对修复 #1: Ctrl+U 清到行首（不是清整行——保留光标后半段）
    if (key.ctrl && inputChar === 'u') {
      setInput((s) => s.slice(cursorOffset))
      setCursorOffset(0)
      return
    }
    if (key.ctrl && inputChar === 'k') {
      // Ctrl+K: 删到行尾（当前 input 就是单行，等同清空）
      setInput('')
        setCursorOffset(0)
        setCursorOffset(0)
      return
    }
    if (key.ctrl && inputChar === 'w') {
      // Ctrl+W: 删最后一个词（按空格/标点分词）
      setInput((s) => {
        const trimmed = s.trimEnd()
        const lastSpace = Math.max(trimmed.lastIndexOf(' '), trimmed.lastIndexOf('\t'))
        return lastSpace === -1 ? '' : trimmed.slice(0, lastSpace + 1)
      })
      return
    }

    // 深度比对修复 #1: 光标移动（左/右/Ctrl+A/E/Home/End）
    if (!key.ctrl && !key.meta) {
      if (key.leftArrow) {
        setCursorOffset((o) => Math.max(0, o - 1))
        return
      }
      if (key.rightArrow) {
        setCursorOffset((o) => Math.min(input.length, o + 1))
        return
      }
    }
    if (key.ctrl) {
      if (inputChar === 'a') { setCursorOffset(0); return }        // Ctrl+A 行首
      if (inputChar === 'e') { setCursorOffset(input.length); return } // Ctrl+E 行尾
      if (inputChar === 'b') { setCursorOffset((o) => Math.max(0, o - 1)); return } // Ctrl+B 左移
      if (inputChar === 'f') { setCursorOffset((o) => Math.min(input.length, o + 1)); return } // Ctrl+F 右移
      // v1.13: emacs 风格 C-n/C-p 历史导航（与 ↑↓ 等效）
      if (inputChar === 'p') {
        const history = inputHistoryRef.current
        if (history.length > 0) {
          if (historyIndexRef.current === -1) historyIndexRef.current = history.length - 1
          else historyIndexRef.current = Math.max(0, historyIndexRef.current - 1)
          const val = history[historyIndexRef.current] ?? ''
          setInput(val); setCursorOffset(val.length)
        }
        return
      }
      if (inputChar === 'n') {
        const history = inputHistoryRef.current
        if (historyIndexRef.current >= 0) {
          historyIndexRef.current++
          if (historyIndexRef.current >= history.length) {
            historyIndexRef.current = -1
            setInput(''); setCursorOffset(0)
          } else {
            const val = history[historyIndexRef.current] ?? ''
            setInput(val); setCursorOffset(val.length)
          }
        }
        return
      }
    }

    // 计算当前输入匹配的命令（实时）
    const hints = matchCommands(input)

    // UX: ↑↓ 在命令提示列表里选中
    if (hints.length > 0 && (key.upArrow || key.downArrow)) {
      if (key.upArrow) {
        setCmdHintIndex((i) => (i <= 0 ? hints.length - 1 : i - 1))
      } else {
        setCmdHintIndex((i) => (i >= hints.length - 1 ? 0 : i + 1))
      }
      return
    }

    // UX: Tab 确认选中命令（填入当前选中的那个）
    if (key.tab && hints.length > 0) {
      setInput(hints[cmdHintIndex]?.cmd ?? hints[0]!.cmd)
      setCmdHintIndex(0)
      return
    }
    // 深度比对修复 #2: 多行输入——Alt+Enter / Shift+Enter 插入换行
    if (key.return && (key.meta || key.shift)) {
      setInput((s) => {
        const before = s.slice(0, cursorOffset)
        const after = s.slice(cursorOffset)
        const newInput = before + '\n' + after
        setCursorOffset(before.length + 1)
        return newInput
      })
      return
    }
    // 回车提交——用 CommandRegistry 分发（替代 17 个 if-else）
    if (key.return) {
      const text = input.trim()

      // 1. 先尝试注册的命令
      if (commandRegistryRef.current && isSlashCommand(text)) {
        const registry = commandRegistryRef.current
        void registry.tryExecute(text, running).then((handled) => {
          if (handled) setInput('')
        setCursorOffset(0)
        setCursorOffset(0)
        })
        // tryExecute 是异步的——先 return 阻止后续处理（tryExecute 内部已经调了 handler）
        if (registry.match(text).length > 0) return
      }

      // 2. 自定义命令（.fuckcode/commands/*.md）
      if (isSlashCommand(text) && !text.startsWith('/ ')) {
        const cmdName = text.slice(1).split(/\s+/)[0] ?? ''
        const cmdArgs = text.slice(1 + cmdName.length).trim()
        if (cmdName && !running) {
          setInput('')
        setCursorOffset(0)
        setCursorOffset(0)
          void handleCustomCommand(cmdName, cmdArgs)
          return
        }
      }

      // 3. 普通对话输入
      if (text && !running) {
        const hist = inputHistoryRef.current
        if (hist[hist.length - 1] !== text) {
          hist.push(text)
          if (hist.length > 100) hist.shift()
          void appendPromptHistory(process.cwd(), text).catch(() => {})
        }
        historyIndexRef.current = -1
        setInput('')
        setCursorOffset(0)
        setCursorOffset(0)
        void runQuery(text)
      }
      return
    }
    // v1.2: ↑↓ 浏览输入历史
    // 深度比对第 49 轮: 多行模式 ↑↓ 先在行内移动，到边界才触发历史（对标 Claude Code useTextInput）
    if (key.upArrow) {
      if (input.includes('\n')) {
        const beforeCursor = input.slice(0, cursorOffset)
        const lineStart = beforeCursor.lastIndexOf('\n') + 1
        const currentCol = cursorOffset - lineStart
        if (lineStart > 0) {
          const prevLineEnd = lineStart - 1
          const prevLineStart = beforeCursor.slice(0, prevLineEnd).lastIndexOf('\n') + 1
          const prevLineLen = prevLineEnd - prevLineStart
          setCursorOffset(prevLineStart + Math.min(currentCol, prevLineLen))
          return
        }
      }
      const history = inputHistoryRef.current
      if (history.length > 0) {
        if (historyIndexRef.current === -1) {
          historyIndexRef.current = history.length - 1
        } else {
          historyIndexRef.current = Math.max(0, historyIndexRef.current - 1)
        }
        const val = history[historyIndexRef.current] ?? ''
        setInput(val)
        setCursorOffset(val.length)
      }
      return
    }
    if (key.downArrow) {
      if (input.includes('\n')) {
        const afterCursor = input.slice(cursorOffset)
        const nextNewline = afterCursor.indexOf('\n')
        if (nextNewline !== -1) {
          const beforeCursor = input.slice(0, cursorOffset)
          const lineStart = beforeCursor.lastIndexOf('\n') + 1
          const currentCol = cursorOffset - lineStart
          const nextLineStart = cursorOffset + nextNewline + 1
          const nextLineEnd = input.indexOf('\n', nextLineStart)
          const nextLineLen = nextLineEnd === -1 ? input.length - nextLineStart : nextLineEnd - nextLineStart
          setCursorOffset(nextLineStart + Math.min(currentCol, nextLineLen))
          return
        }
      }
      const history = inputHistoryRef.current
      if (historyIndexRef.current >= 0) {
        historyIndexRef.current++
        if (historyIndexRef.current >= history.length) {
          historyIndexRef.current = -1
          setInput('')
        setCursorOffset(0)
        } else {
          const val = history[historyIndexRef.current] ?? ''
          setInput(val)
          setCursorOffset(val.length)
        }
      }
      return
    }
    // 退格——删除光标前一个字符（深度比对 #1: 支持中间位置删除）
    if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        setInput((s) => s.slice(0, cursorOffset - 1) + s.slice(cursorOffset))
        setCursorOffset((o) => Math.max(0, o - 1))
      }
      return
    }
    // 普通文本输入（支持中文 IME 一次提交多个字符 + 粘贴）
    // 原先 length === 1 会拒绝 IME 提交的"你好"（长度 2），导致中文只能逐字输入。
    // 改为：只要不是 ctrl/meta 组合、且至少含一个非控制字符，就追加。
    if (!key.ctrl && !key.meta && inputChar) {
      // 过滤纯控制字符（如孤立的 \x1b Esc），但保留所有可见文本（含中文/emoji）
      // 允许可见字符 + 空格（空格之前被 \S 过滤掉了，导致 /plan 后没法输入需求）
      // 仍排除纯控制字符（如孤立的 Esc）
      const isValidChar = inputChar.trim().length > 0 && !/^\x1b+$/.test(inputChar)
      // 深度比对修复 #10: 大段粘贴截断（超 10000 字符截断防卡死）
      const MAX_INPUT = 10000
      if (isValidChar || inputChar === ' ') {
        // 深度比对修复 #1: 在 cursorOffset 处插入而非末尾追加
        setInput((s) => {
          const before = s.slice(0, cursorOffset)
          const after = s.slice(cursorOffset)
          const newInput = before + inputChar + after
          if (newInput.length > MAX_INPUT) {
            return newInput.slice(0, MAX_INPUT) + '\n[输入过长，已截断]'
          }
          // 光标跟随移动
          setCursorOffset(before.length + inputChar.length)
          return newInput
        })
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

      {/* 消息流——委托给 MessageList 子组件 */}
      <MessageList messages={history} running={running} />

      {/* 权限弹窗 */}
      {pendingPermission && (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow" bold>[WARN] {pendingPermission.tool}</Text>
          <Text>{pendingPermission.summary}</Text>
          <Box marginTop={1}>
            {(() => {
              const opts = ['本次允许', '总是允许', '拒绝']
              const colors = ['green', 'cyan', 'red']
              return opts.map((label, i) => {
                const sel = i === permSel
                const sep = i > 0 ? '   ' : ''
                return (
                  <React.Fragment key={label}>
                    <Text dimColor>{sep}</Text>
                    <Text color={colors[i]} bold={sel} backgroundColor={sel ? colors[i] : undefined}>
                      {sel ? ` › ${label}‹ ` : `  ${label}  `}
                    </Text>
                  </React.Fragment>
                )
              })
            })()}
          </Box>
          <Text dimColor>← → 切换 · Enter 确认 · (y/a/n 快捷键)</Text>
        </Box>
      )}

      {/* v1.19: AskUserQuestion 选择弹窗 */}
      {pendingQuestion && (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text color="cyan" bold>❓ {pendingQuestion.header}</Text>
          <Text>{pendingQuestion.question}</Text>
          <Box marginTop={1} flexDirection="column">
            {pendingQuestion.options.map((opt, i) => {
              const sel = i === questionSel
              const checked = pendingQuestion.multiSelect && questionChecked.includes(i)
              const mark = pendingQuestion.multiSelect ? (checked ? '[x]' : '[ ]') : (sel ? '›' : ' ')
              const rec = opt.recommended ? ' (推荐)' : ''
              return (
                <Box key={i}>
                  <Text color={sel ? 'cyan' : undefined} bold={sel}>
                    {` ${mark} ${i + 1}. ${opt.label}${rec}`}
                  </Text>
                </Box>
              )
            })}
          </Box>
          {pendingQuestion.options[questionSel]?.description && (
            <Text dimColor>  {pendingQuestion.options[questionSel]!.description}</Text>
          )}
          <Text dimColor>← → 或 1-{pendingQuestion.options.length} 切换 · {pendingQuestion.multiSelect ? 'Space 勾选 · ' : ''}Enter 确认</Text>
        </Box>
      )}

      {/* 输入框——委托给 InputBox 子组件 */}
      <InputBox input={input} running={running} visible={!pendingPermission && !pendingQuestion} cursorOffset={cursorOffset} vimMode={vimIndicator} />

      {/* 实时命令提示——委托给 CommandHints 子组件 */}
      <CommandHints
        hints={matchCommands(input).map((c) => ({ cmd: c.cmd, desc: c.desc, args: c.args, example: c.example }))}
        selectedIndex={cmdHintIndex}
        visible={!pendingPermission && !pendingQuestion && !running && input.startsWith('/')}
      />

      {/* 底部状态栏——委托给 StatusBar 子组件 */}
      <StatusBar
        running={running}
        pendingPermission={!!pendingPermission}
        model={currentModel}
        totalTokens={totalTokensRef.current}
        idleAttitude={idleAttitudeRef.current}
        genAttitude={genAttitudeRef.current}
        subagentDescs={subagentDescs}
      />
    </Box>
  )
}
