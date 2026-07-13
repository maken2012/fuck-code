// src/llm/anthropic.ts
// Anthropic 流式调用封装。照搬 Claude Code 模式：
// - 用 messages.create({stream:true}) 而非 messages.stream()（避免 O(n²) JSON 解析）
// - 自己累积 block 状态，不用 SDK 的 MessageStream helper
// - content_block_start 只记录 index，不取 text（SDK 会重复发，text 只从 delta 取）
// - input_tokens 只取 message_start，output_tokens 只取 message_delta
// - abort 转成 AbortError；支持 _clientOverride 用于测试 mock
import Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage, LlmEvent } from '@/llm/types.js'

// create 的调用签名（mock 与真实 SDK client 都满足此结构）。
// 返回 Promise（SDK 的 create 返回 APIPromise，是 thenable）。
type CreateFn = (
  body: object,
  opts?: object,
) => PromiseLike<AsyncIterable<RawStreamEvent>> | AsyncIterable<RawStreamEvent>

// 测试用：注入 mock client（生产代码不传）。
export interface MockClient {
  messages: { create: CreateFn }
}

export interface StreamAnthropicOpts {
  model: string
  system: string
  messages: ChatMessage[]
  maxTokens?: number
  signal: AbortSignal
  apiKey?: string
  /** 测试用：注入 mock client（生产代码不传） */
  _clientOverride?: MockClient
}

// SDK 流式事件的最小类型刻画（只列我们关心的字段）。导出供测试构造 mock 事件。
export interface RawStreamEvent {
  type: string
  message?: {
    usage?: {
      input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  index?: number
  content_block?: { type: string }
  delta?: { type?: string; text?: string; stop_reason?: string }
  usage?: { output_tokens?: number }
}

export async function* streamAnthropic(
  opts: StreamAnthropicOpts,
): AsyncGenerator<LlmEvent> {
  // 构造 client（测试时用 override）。SDK 的 Anthropic 与 MockClient 在结构上
  // create 签名不协变，但运行时调用兼容，统一转成 MockClient 形态调用。
  const client: MockClient =
    opts._clientOverride ??
    (new Anthropic({ apiKey: opts.apiKey }) as unknown as MockClient)

  let stream: AsyncIterable<RawStreamEvent>
  try {
    stream = await client.messages.create(
      {
        model: opts.model,
        max_tokens: opts.maxTokens ?? 8192,
        system: opts.system,
        messages: opts.messages,
        stream: true,
      },
      { signal: opts.signal },
    )
  } catch (e) {
    if (opts.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    throw e
  }

  // 自己累积 block 状态（Claude Code 风格）
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let stopReason = 'end_turn'

  try {
    for await (const part of stream) {
      switch (part.type) {
        case 'message_start':
          // input usage 在这里（output_tokens 此时是 0）
          if (part.message?.usage) {
            inputTokens = part.message.usage.input_tokens ?? 0
            cacheRead = part.message.usage.cache_read_input_tokens ?? 0
          }
          break
        case 'content_block_start':
          // 只记录 index，不取 text——SDK 会在这里发一遍内容，然后 delta 又发，必须防重复
          break
        case 'content_block_delta':
          if (part.delta?.type === 'text_delta' && part.delta.text) {
            yield { type: 'text', textDelta: part.delta.text }
          }
          break
        case 'message_delta':
          // output 累计值；input 类不取（可能发 0 覆盖掉 message_start 的值）
          if (part.usage) outputTokens = part.usage.output_tokens ?? outputTokens
          if (part.delta?.stop_reason) stopReason = part.delta.stop_reason
          break
        case 'message_stop':
          break
      }
    }
  } catch (e) {
    if (opts.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    yield { type: 'error', error: e as Error }
    return
  }

  yield { type: 'usage', input: inputTokens, output: outputTokens, cacheRead }
  yield { type: 'done', stopReason }
}
