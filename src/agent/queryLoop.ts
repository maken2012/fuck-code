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
// 关键约定（M2 兼容）：
// - opts.history 的 content 仍用 string（Repl 层简化）
// - queryLoop 内部 messages 用 string | ContentBlock[] 的完整结构化形态
// - abort 抛 AbortError → yield aborted + done
import type { ChatMessage, ContentBlock, LlmEvent } from '@/llm/types.js'
import type { QueryEvent } from '@/agent/types.js'
import type { Tool } from '@/tools/Tool.js'
import { streamAnthropic } from '@/llm/anthropic.js'
import { findTool, toolsToAnthropicFormat } from '@/tools/registry.js'

// 防止模型无限调工具导致死循环（M3 安全护栏）
const MAX_TURNS = 20

export interface QueryLoopOpts {
  history: ChatMessage[] // 已有对话历史（不含本次 user 输入）
  userInput: string // 本次用户输入
  model: string
  system: string
  maxTokens?: number
  signal: AbortSignal
  apiKey?: string
  /** M3：工作目录（工具执行需要） */
  cwd: string
  /** M3：可用工具列表（不传则禁用工具，退化为 M2 单轮） */
  tools?: Tool[]
  /** 测试用：注入 mock streamAnthropic（生产代码不传） */
  _llmOverride?: (opts: object) => AsyncGenerator<LlmEvent>
}

export async function* queryLoop(
  opts: QueryLoopOpts,
): AsyncGenerator<QueryEvent> {
  const tools = opts.tools ?? []
  const hasTools = tools.length > 0

  // 内部消息数组：复制 history + 加本次 user 输入。
  // history 的 content 在 M2 是 string；queryLoop 内部可能产生结构化数组。
  const messages: ChatMessage[] = [
    ...opts.history,
    { role: 'user', content: opts.userInput },
  ]

  // 选 LLM stream 函数（测试用 override，生产用 streamAnthropic）
  const streamFn =
    opts._llmOverride ??
    (streamAnthropic as (o: object) => AsyncGenerator<LlmEvent>)

  try {
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
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
        messages.push({ role: 'assistant', content: assistantText })
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
      messages.push({ role: 'assistant', content: assistantBlocks })

      // 执行所有工具，收集结果。工具执行错误不终止循环（把错误回灌给模型）
      const toolResultBlocks: ContentBlock[] = []
      for (const tu of toolUses) {
        const tool = findTool(tu.name, tools)
        if (!tool) {
          const content = `错误：未知工具 ${tu.name}`
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content,
            is_error: true,
          })
          yield {
            type: 'tool_result',
            tool: tu.name,
            ok: false,
            content,
          }
          continue
        }
        const result = await tool.execute(tu.input, {
          cwd: opts.cwd,
          abortSignal: opts.signal,
        })
        const content = result.ok
          ? (tool.formatResult
              ? tool.formatResult(result.data)
              : JSON.stringify(result.data))
          : `错误: ${result.error}`
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content,
          is_error: result.ok ? undefined : true,
        })
        yield {
          type: 'tool_result',
          tool: tu.name,
          ok: result.ok,
          content,
        }
      }

      // tool_result 拼回 messages（结构化 user content），继续下一轮
      messages.push({ role: 'user', content: toolResultBlocks })
      yield { type: 'turn_end', stopReason: 'tool_use' }
    }

    // 超过 MAX_TURNS：yield error + done（recoverable=true 让 Repl 能继续）
    yield {
      type: 'error',
      error: new Error(`达到最大轮次限制（${MAX_TURNS}）`),
      recoverable: true,
    }
    yield { type: 'done' }
  } catch (e) {
    if (opts.signal.aborted) {
      yield { type: 'aborted' }
      yield { type: 'done' }
      return
    }
    yield { type: 'error', error: e as Error, recoverable: false }
    yield { type: 'done' }
  }
}
