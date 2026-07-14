// src/agent/queryLoop.ts
// 主循环 async generator（M3 工具循环版）。
//
// 从 M2 单轮扩展为 while 循环：
//   1. 把 userInput 加进 messages
//   2. 循环调 LLM：
//      a. 流式收集 text + tool_uses，同时转发事件给上层
//      b. 把 assistant 回复拼回 messages（纯文本用 string，含 tool_use 用结构化数组）
//      c. 没有 tool_use：yield turn_end + done，return
//      d. 执行所有工具（yield tool_use_start → execute → yield tool_result）
//      e. 把 tool_result 拼回 messages（结构化 user content）
//      f. yield turn_end(stopReason='tool_use')，继续下一轮
//   3. 超过 MAX_TURNS：yield error
//
// M5 新增：可选 session 持久化 + autoCompact。
//   - opts.sessionId：提供时启动期 loadMessages 作为 messages 起点，
//     每轮新消息 appendMessages 到 JSONL。
//   - opts.contextWindow：用于 getCompactThreshold，每轮开始前检查
//     estimateMessagesTokens > threshold 时调 compactConversation 生成摘要，
//     writeCompactBoundary 写盘 + 内存 messages 替换为 compact boundary，
//     yield { type: 'compacted' } 通知 UI。
//
// 关键约定（M2 兼容）：
// - opts.history 的 content 仍用 string（Repl 层简化）
// - queryLoop 内部 messages 用 string | ContentBlock[] 的完整结构化形态
// - abort 抛 AbortError → yield aborted + done
import type { ChatMessage, ContentBlock, LlmEvent } from '@/llm/types.js'
import type { QueryEvent, PermissionUserDecision } from '@/agent/types.js'
import type { Tool } from '@/tools/Tool.js'
import { streamMessage, streamMessageWithFallback } from '@/llm/provider.js'
import { LLMClient } from '@/llm/LLMClient.js'
import { ToolExecutor } from '@/agent/ToolExecutor.js'
import type { ToolUseRequest } from '@/agent/ToolExecutor.js'
import { findTool, toolsToAnthropicFormat } from '@/tools/registry.js'
import { checkPermission } from '@/permissions/decision.js'
import { PermissionManager } from '@/permissions/PermissionManager.js'
import { SessionManager } from '@/services/SessionManager.js'
import type { PermissionMode } from '@/permissions/modes.js'
import { loadHooks, triggerHooks } from '@/hooks/HookManager.js'
import type { HooksFile } from '@/hooks/HookManager.js'
import {
  appendMessages,
  loadMessages,
  writeCompactBoundary,
} from '@/services/Session.js'
import { estimateMessagesTokens } from '@/utils/tokens.js'
import { microCompactMessages } from '@/agent/microCompact.js'
import { autoSaveMemories } from '@/agent/autoMemory.js'
import {
  compactConversation,
  getCompactThreshold,
} from '@/agent/compact.js'

// 防止模型无限调工具导致死循环（M3 安全护栏）
const MAX_TURNS = 20

// 默认 contextWindow（与 Config.ts 的 schema 默认一致）
const DEFAULT_CONTEXT_WINDOW = 200000

// Session 服务接口（用于生产代码直接 import + 测试用 _sessionOverride 注入）。
// 把 queryLoop 实际依赖的 Session 函数收拢成一个对象，便于 mock。
export interface SessionApi {
  loadMessages: (
    sessionId: string,
    cwd: string,
  ) => Promise<ChatMessage[]>
  appendMessages: (
    sessionId: string,
    cwd: string,
    messages: ChatMessage[],
  ) => Promise<void>
  writeCompactBoundary: (
    sessionId: string,
    cwd: string,
    summary: string,
  ) => Promise<void>
}

// refactor: 默认 Session 实现委托给 SessionManager 类（OOP）
// SessionManager 有状态（持有 sessionId），这里包一层适配 SessionApi 无状态接口
const defaultSessionApi: SessionApi = {
  loadMessages: (sessionId, cwd) => {
    const sm = new SessionManager(cwd)
    return sm.resume(sessionId)
  },
  appendMessages: async (sessionId, cwd, messages) => {
    const sm = new SessionManager(cwd)
    // resume 让 sm 持有 sessionId，然后 append
    await sm.resume(sessionId)
    await sm.append(messages)
  },
  writeCompactBoundary: async (sessionId, cwd, summary) => {
    const sm = new SessionManager(cwd)
    await sm.resume(sessionId)
    await sm.writeBoundary(summary)
  },
}

export interface QueryLoopOpts {
  history: ChatMessage[] // 已有对话历史（不含本次 user 输入）
  userInput: string // 本次用户输入
  model: string
  system: string
  maxTokens?: number
  signal: AbortSignal
  apiKey?: string
  /** M6：第三方 Anthropic 兼容 API 的 baseURL（中转/代理） */
  apiBaseUrl?: string
  /** v1.11：主模型过载/429 时按序尝试的备用模型 */
  fallbackModels?: string[]
  /** v1.13：强制指定 provider（覆盖 detectProvider 自动判定） */
  provider?: 'anthropic' | 'openai' | 'openai-compatible'
  /** M3：工作目录（工具执行需要） */
  cwd: string
  /** M3：可用工具列表（不传则禁用工具，退化为 M2 单轮） */
  tools?: Tool[]
  /** M4：权限模式（默认 'default'：只读放行、写询问） */
  permissionMode?: PermissionMode
  /** M4：权限规则（allow/ask/deny 三类规则字符串） */
  permissions?: { allow: string[]; ask: string[]; deny: string[] }
  /** M5：会话 id（提供则启用 JSONL 持久化 + 跨启动恢复历史） */
  sessionId?: string
  /** M5：上下文窗口大小，用于 autoCompact 阈值（默认 200000） */
  contextWindow?: number
  /** 测试用：注入 mock streamAnthropic（生产代码不传） */
  _llmOverride?: (opts: object) => AsyncGenerator<LlmEvent>
  /** 测试用：注入 mock Session（生产代码不传） */
  _sessionOverride?: SessionApi
  /** v1.3: 测试用：注入 mock hooks（生产代码不传，自动从 .fuckcode/hooks.json 加载） */
  _hooksOverride?: HooksFile
}

// summarizeInput 已移入 ToolExecutor.formatToolSummary（静态方法）

export async function* queryLoop(
  opts: QueryLoopOpts,
): AsyncGenerator<QueryEvent> {
  const tools = opts.tools ?? []
  const hasTools = tools.length > 0

  // M4：跨工具共享的已读文件状态（Read 写入；Edit/Write 执行前校验）
  const readFileState = new Map<string, { mtime: number; readAt: number }>()

  // 选 Session 实现（测试用 override，生产用 defaultSessionApi）
  const sessionApi = opts._sessionOverride ?? defaultSessionApi

  // v1.3: 加载 hooks 配置（.fuckcode/hooks.json）
  // v1.3+v1.11: 加载 hooks（safe-mode 跳过）
  const hooks: HooksFile = opts._hooksOverride ?? (process.env.FUCKCODE_SAFE_MODE === '1' ? {} : await loadHooks(opts.cwd).catch(() => ({})))

  // UserPromptSubmit hook：用户提交 prompt 时触发，可注入额外上下文
  const promptHookResult = await triggerHooks('UserPromptSubmit', { prompt: opts.userInput }, hooks, opts.cwd)
  const effectiveUserInput = promptHookResult.additionalContext
    ? `${opts.userInput}\n\n[hook 注入上下文]\n${promptHookResult.additionalContext}`
    : opts.userInput

  // M5：如果有 sessionId，加载磁盘历史作为 messages 起点（忽略 opts.history）；
  //     否则回退到调用方传入的 history（M2-M4 兼容）。
  // 失败按空数组处理（loadMessages 自身已容错，这里 catch 保险）。
  let messages: ChatMessage[]
  if (opts.sessionId) {
    messages = await sessionApi
      .loadMessages(opts.sessionId, opts.cwd)
      .catch(() => [] as ChatMessage[])
  } else {
    messages = [...opts.history]
  }

  // 本次用户输入加入 messages。
  const userMessage: ChatMessage = { role: 'user', content: effectiveUserInput }

  // v1.12: 自动记忆提取（safe-mode 跳过）。检测用户偏好/约定/禁忌，自动存为 memory。
  if (process.env.FUCKCODE_SAFE_MODE !== '1') {
    void autoSaveMemories(opts.cwd, opts.userInput).catch(() => {})
  }
  messages.push(userMessage)

  // 本轮新增的消息（user input + assistant 回复 + tool_result）。
  // 每个 turn 内累积，turn 结束后 flush 到磁盘。第一个 turn 的 user input 也要落盘。
  // 注意：若触发了 autoCompact，新增队列要重置（compact 已落盘 boundary）。
  let pendingPersist: ChatMessage[] = [userMessage]

  // refactor: LLMClient 封装 provider 路由 + fallback 链（OOP）
  // 测试用 _llmOverride 钩子（保持向后兼容）
  const llmClient = LLMClient.fromConfig({
    apiKey: opts.apiKey,
    apiBaseUrl: opts.apiBaseUrl,
    provider: opts.provider,
    fallbackModels: opts.fallbackModels,
  })
  const streamFn =
    opts._llmOverride ??
    ((o: object) => llmClient.stream(o as Parameters<typeof llmClient.stream>[0]))

  // refactor: PermissionManager 封装权限决策管线（OOP）
  const permManager = PermissionManager.fromConfig({
    permissionMode: opts.permissionMode,
    permissions: opts.permissions,
  })

  // M5：autoCompact 阈值（默认 200000 contextWindow）
  const contextWindow = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const compactThreshold = getCompactThreshold(contextWindow)

  try {
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      // v1.5: microCompact——先做细粒度回收（替换旧的大工具结果）
      // 比 autoCompact（全量摘要）更省且保护 cache 前缀
      if (opts.sessionId) {
        const replaced = microCompactMessages(messages)
        if (replaced > 0) {
          yield { type: 'compacted', summary: `microCompact: 替换了 ${replaced} 个旧工具结果` }
        }
      }
      // M5：每轮调 LLM 前检查 token 是否超阈值 → 触发压缩。
      // 深度比对第 17 轮: 改进触发提示——显示压缩前后 token 数
      if (
        opts.sessionId &&
        estimateMessagesTokens(messages) > compactThreshold
      ) {
        const tokensBefore = estimateMessagesTokens(messages)
        const summary = await compactConversation(messages, {
          model: opts.model,
          apiKey: opts.apiKey,
          ...(opts.apiBaseUrl ? { apiBaseUrl: opts.apiBaseUrl } : {}),
          ...(opts.provider ? { provider: opts.provider } : {}),
          signal: opts.signal,
          _llmOverride: opts._llmOverride,
        }).catch(() => '')
        if (summary) {
          // 写 boundary 到磁盘（持久化压缩点）
          await sessionApi
            .writeCompactBoundary(opts.sessionId, opts.cwd, summary)
            .catch(() => {})
          // 内存里：messages 替换成只含 boundary
          messages = [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `<compact>之前对话的摘要：\n${summary}</compact>`,
                  _meta: { compactBoundary: true },
                } as ContentBlock & {
                  _meta: { compactBoundary: boolean }
                },
              ],
            },
          ]
          // 重置持久化队列：boundary 已通过 writeCompactBoundary 落盘，
          // 不需要 pendingPersist 重复写它。
          pendingPersist = []
          // 深度比对第 17 轮: 显示压缩前后 token 数
          const tokensAfter = estimateMessagesTokens(messages)
          const saved = tokensBefore - tokensAfter
          yield { type: 'compacted', summary: `上下文已压缩：${tokensBefore} → ${tokensAfter} tokens（省 ${saved}）\n${summary.slice(0, 100)}` }
        }
      }

      let assistantText = ''
      // 收集本轮所有 tool_use（执行后拼回 messages）
      const toolUses: {
        id: string
        name: string
        input: unknown
      }[] = []
      let stopReason = 'end_turn'

      // 构造 stream 子选项（仅在有工具时附加 tools 字段）
      const streamOpts: Record<string, unknown> = {
        model: opts.model,
        system: opts.system,
        messages,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
        apiKey: opts.apiKey,
        ...(opts.apiBaseUrl ? { apiBaseUrl: opts.apiBaseUrl } : {}),
        ...(opts.fallbackModels ? { fallbackModels: opts.fallbackModels } : {}),
        ...(opts.provider ? { provider: opts.provider } : {}),
        systemCacheable: true, // M6: 启用 prompt cache，system 静态段跨轮命中
      }
      if (hasTools) {
        streamOpts.tools = toolsToAnthropicFormat(tools)
      }

      for await (const event of streamFn(streamOpts)) {
        switch (event.type) {
          case 'text':
            assistantText += event.textDelta
            yield { type: 'text_delta', text: event.textDelta }
            break
          case 'thinking':
            // 深度比对修复 #8: 转发 thinking/reasoning 事件
            yield { type: 'thinking_delta', text: event.textDelta }
            break
          case 'tool_use':
            toolUses.push({
              id: event.toolUseId,
              name: event.toolName,
              input: event.input,
            })
            yield {
              type: 'tool_use_start',
              tool: event.toolName,
              input: event.input,
            }
            break
          case 'usage':
            yield {
              type: 'usage',
              input: event.input,
              output: event.output,
              cacheRead: event.cacheRead,
            }
            break
          case 'done':
            stopReason = event.stopReason
            break
          case 'error':
            yield { type: 'error', error: event.error, recoverable: true }
            break
        }
      }

      // 把 assistant 回复加入 messages：
      // - 纯文本（无 tool_use）→ string content（M2 兼容）
      // - 含 tool_use → 结构化数组（text block + tool_use blocks）
      if (toolUses.length === 0) {
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: assistantText,
        }
        messages.push(assistantMsg)
        pendingPersist.push(assistantMsg)
        // M5：持久化本轮新增（user + assistant）
        if (opts.sessionId) {
          await sessionApi
            .appendMessages(opts.sessionId, opts.cwd, pendingPersist)
            .catch(() => {})
        }
        yield { type: 'turn_end', stopReason }
        yield { type: 'done' }
        return
      }
      const assistantBlocks: ContentBlock[] = []
      if (assistantText) {
        assistantBlocks.push({ type: 'text', text: assistantText })
      }
      for (const tu of toolUses) {
        assistantBlocks.push({
          type: 'tool_use',
          id: tu.id,
          name: tu.name,
          input: tu.input,
        })
      }
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: assistantBlocks,
      }
      messages.push(assistantMsg)
      pendingPersist.push(assistantMsg)

      // v1.2+refactor: 工具执行逻辑封装在 ToolExecutor 类（OOP 分层）
      // 但权限检查里的 ask 交互仍由 queryLoop 的 yield* askPermission 协调
      // （因为 async generator 的 yield 不能穿透到 Promise 回调）
      // 策略：queryLoop 先做权限检查（含 ask），ToolExecutor 只执行已通过的工具
      const toolResultBlocks: ContentBlock[] = []
      const permittedForExec: ToolUseRequest[] = []

      for (const tu of toolUses) {
        const tool = findTool(tu.name, tools)
        if (!tool) {
          const content = `错误：未知工具 ${tu.name}`
          toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content, is_error: true })
          yield { type: 'tool_result', tool: tu.name, ok: false, content }
          continue
        }

        // PreToolUse hook
        let effectiveInput: unknown = tu.input
        const preHook = await triggerHooks('PreToolUse', { tool: tu.name, toolInput: tu.input }, hooks, opts.cwd)
        if (preHook.updatedInput) effectiveInput = preHook.updatedInput
        if (preHook.permissionDecision === 'deny') {
          const content = `hook 拒绝: ${preHook.additionalContext ?? 'PreToolUse hook denied'}`
          toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content, is_error: true })
          yield { type: 'tool_result', tool: tu.name, ok: false, content }
          continue
        }

        // 权限检查（通过 PermissionManager 类）
        const perm = await permManager.check(tool, effectiveInput, {
          cwd: opts.cwd,
          abortSignal: opts.signal,
          readFileState,
        })
        if (perm.decision === 'deny') {
          const content = `权限拒绝: ${perm.reason ?? '匹配 deny 规则'}`
          toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content, is_error: true })
          yield { type: 'tool_result', tool: tu.name, ok: false, content }
          continue
        }
        if (perm.decision === 'ask') {
          const userDecision = yield* permManager.createAskGenerator(tu.name, tu.input, ToolExecutor.formatToolSummary)
          if (userDecision === 'deny') {
            const content = `用户拒绝执行 ${tu.name}`
            toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content, is_error: true })
            yield { type: 'tool_result', tool: tu.name, ok: false, content }
            continue
          }
        }
        permittedForExec.push({ id: tu.id, name: tu.name, input: effectiveInput })
      }

      // 用 ToolExecutor 执行已通过权限检查的工具（并发分组 + 执行 + 结果收集）
      if (permittedForExec.length > 0) {
        const executor = new ToolExecutor(tools, findTool)
        const execBlocks = yield* executor.executePermitted(permittedForExec, {
          cwd: opts.cwd,
          abortSignal: opts.signal,
          readFileState,
          parentHistory: messages,
        })
        toolResultBlocks.push(...execBlocks.blocks)
        for (const evt of execBlocks.events) yield evt
      }

      // tool_result 拼回 messages（结构化 user content），继续下一轮
      const toolResultMsg: ChatMessage = {
        role: 'user',
        content: toolResultBlocks,
      }
      messages.push(toolResultMsg)
      pendingPersist.push(toolResultMsg)

      // M5：持久化本轮新增（assistant + tool_results）。
      // 中间 tool 轮也写盘 —— 后续若中断重启仍能恢复到合理位置。
      if (opts.sessionId) {
        await sessionApi
          .appendMessages(opts.sessionId, opts.cwd, pendingPersist)
          .catch(() => {})
        // 清空 pending（下一轮从空开始）
        pendingPersist = []
      }
      yield { type: 'turn_end', stopReason: 'tool_use' }
    }

    // 超过 MAX_TURNS：yield error + done（recoverable=true 让 Repl 能继续）
    // 兜底：把残留 pendingPersist 也落盘（防止丢 user input）
    if (opts.sessionId && pendingPersist.length > 0) {
      await sessionApi
        .appendMessages(opts.sessionId, opts.cwd, pendingPersist)
        .catch(() => {})
    }
    yield {
      type: 'error',
      error: new Error(`达到最大轮次限制（${MAX_TURNS}）`),
      recoverable: true,
    }
    yield { type: 'done' }
  } catch (e) {
    if (opts.signal.aborted) {
      // 中断时把已生成的内容落盘（保证可 resume）
      if (opts.sessionId && pendingPersist.length > 0) {
        await sessionApi
          .appendMessages(opts.sessionId, opts.cwd, pendingPersist)
          .catch(() => {})
      }
      yield { type: 'aborted' }
      yield { type: 'done' }
      return
    }
    yield { type: 'error', error: e as Error, recoverable: false }
    yield { type: 'done' }
  }
}
