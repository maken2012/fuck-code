// src/agent/queryLoop.ts
// 主循环 async generator（M2 无工具版）。
// 每次调用：把 userInput 加进 history，调 LLM，流式 yield 事件。
// M3 加工具后会扩展成 while 循环（有 tool_use 就继续），M2 是单轮。
import type { ChatMessage, LlmEvent } from '@/llm/types.js'
import type { QueryEvent } from '@/agent/types.js'
import { streamAnthropic } from '@/llm/anthropic.js'

export interface QueryLoopOpts {
  history: ChatMessage[] // 已有对话历史（不含本次 user 输入）
  userInput: string // 本次用户输入
  model: string
  system: string
  maxTokens?: number
  signal: AbortSignal
  apiKey?: string
  /** 测试用：注入 mock streamAnthropic（生产代码不传） */
  _llmOverride?: (opts: object) => AsyncGenerator<LlmEvent>
}

export async function* queryLoop(opts: QueryLoopOpts): AsyncGenerator<QueryEvent> {
  // 把 user 输入加进历史
  const messages: ChatMessage[] = [
    ...opts.history,
    { role: 'user', content: opts.userInput },
  ]

  // 选 LLM stream 函数（测试用 override，生产用 streamAnthropic）
  const streamFn =
    opts._llmOverride ??
    (streamAnthropic as (o: object) => AsyncGenerator<LlmEvent>)

  try {
    for await (const event of streamFn({
      model: opts.model,
      system: opts.system,
      messages,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
      apiKey: opts.apiKey,
    })) {
      switch (event.type) {
        case 'text':
          yield { type: 'text_delta', text: event.textDelta }
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
          yield { type: 'turn_end', stopReason: event.stopReason }
          break
        case 'error':
          yield { type: 'error', error: event.error, recoverable: true }
          break
      }
    }
  } catch (e) {
    if (opts.signal.aborted) {
      yield { type: 'aborted' }
      yield { type: 'done' }
      return
    }
    yield { type: 'error', error: e as Error, recoverable: false }
    yield { type: 'done' }
    return
  }

  yield { type: 'done' }
}
