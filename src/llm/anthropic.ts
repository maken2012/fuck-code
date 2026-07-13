// src/llm/anthropic.ts
// Anthropic 流式调用封装。照搬 Claude Code 模式：
// - 用 messages.create({stream:true}) 而非 messages.stream()（避免 O(n²) JSON 解析）
// - 自己累积 block 状态，不用 SDK 的 MessageStream helper
// - content_block_start 只记录 index，不取 text（SDK 会重复发，text 只从 delta 取）
// - input_tokens 只取 message_start，output_tokens 只取 message_delta
// - abort 转成 AbortError；支持 _clientOverride 用于测试 mock
//
// M3 新增：
// - tools 参数透传到 messages.create body
// - 解析 tool_use 类型 content_block（content_block_start 记 id/name，
//   content_block_delta 的 input_json_delta 累积 partial_json，
//   content_block_stop 时 yield tool_use 事件）
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
  /** M3：Anthropic tools API 格式的工具定义数组 */
  tools?: object[]
  /** M6：启用 prompt cache（system 静态段 + 末条 user message 加 cache_control） */
  systemCacheable?: boolean
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
  // content_block：text / tool_use 都可能（M3）
  content_block?: {
    type?: string
    // tool_use 专属
    id?: string
    name?: string
    // text 专属（content_block_start 里 SDK 会塞一遍 text，我们忽略）
    text?: string
  }
  delta?:
    | { type?: string; text?: string; stop_reason?: string } // text_delta / message_delta
    | { type: 'input_json_delta'; partial_json: string } // tool_use input 碎片
  usage?: { output_tokens?: number }
}

// M6: 网络错误/429 限流重试（最多 3 次，指数退避）。非可重试错误直接抛。
async function createWithRetry(
  client: MockClient,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<AsyncIterable<RawStreamEvent>> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await client.messages.create(body, { signal })
      return result as AsyncIterable<RawStreamEvent>
    } catch (e) {
      lastError = e
      if (signal.aborted) throw e
      const err = e as { status?: number; code?: string; headers?: { 'retry-after'?: string } }
      const is429 = err.status === 429
      const isNetwork = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND'
      // 只重试 429 和网络错误，其他（4xx 客户端错误）直接抛
      if (!is429 && !isNetwork) throw e
      if (attempt < 2) {
        // 429 读 retry-after；网络错误指数退避 1s/2s
        const delay = is429
          ? parseInt(err.headers?.['retry-after'] ?? '1') * 1000
          : 1000 * (attempt + 1)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }
  throw lastError
}

export async function* streamAnthropic(
  opts: StreamAnthropicOpts,
): AsyncGenerator<LlmEvent> {
  // 构造 client（测试时用 override）。SDK 的 Anthropic 与 MockClient 在结构上
  // create 签名不协变，但运行时调用兼容，统一转成 MockClient 形态调用。
  const client: MockClient =
    opts._clientOverride ??
    (new Anthropic({ apiKey: opts.apiKey }) as unknown as MockClient)
  // 构造 messages.create body。tools 仅在有值时附加（空数组会让 API 报错）。
  // M6: systemCacheable 时 system 用 TextBlockParam 数组 + cache_control（静态段稳定后跨轮命中 cache）
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 8192,
    messages: opts.messages,
    stream: true,
  }
  if (opts.systemCacheable) {
    body.system = [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral', ttl: '1h' } }]
  } else {
    body.system = opts.system
  }
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools
  }

  let stream: AsyncIterable<RawStreamEvent>
  try {
    stream = await createWithRetry(client, body, opts.signal)
  } catch (e) {
    if (opts.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    throw e
  }

  // 自己累积 block 状态（Claude Code 风格）
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let stopReason = 'end_turn'

  // tool_use block 的累积状态（按 index 索引）。content_block_stop 时 yield。
  // 每个 index 对应一个独立的 content block；text 块直接 yield 不在此存。
  const toolBlocks = new Map<
    number,
    { id: string; name: string; inputJson: string }
  >()

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
          // tool_use：记录 index + id + name，初始化 inputJson 累积器
          // text：只记录 index，不取 text（SDK 会重复发，text 只从 delta 取）
          if (part.content_block?.type === 'tool_use') {
            const idx = part.index ?? 0
            toolBlocks.set(idx, {
              id: part.content_block.id ?? '',
              name: part.content_block.name ?? '',
              inputJson: '',
            })
          }
          break
        case 'content_block_delta':
          if (!part.delta) break
          if ('partial_json' in part.delta) {
            // tool_use input 的流式碎片（input_json_delta）
            const idx = part.index ?? 0
            const tb = toolBlocks.get(idx)
            if (tb) tb.inputJson += part.delta.partial_json
          } else if (part.delta.type === 'text_delta' && part.delta.text) {
            yield { type: 'text', textDelta: part.delta.text }
          }
          break
        case 'content_block_stop': {
          // 如果该 index 是 tool_use，解析完整 input 并 yield tool_use 事件
          const idx = part.index ?? 0
          const tb = toolBlocks.get(idx)
          if (tb) {
            let parsedInput: unknown
            try {
              // 空字符串视作空对象（部分场景模型可能不发 input 碎片）
              parsedInput = tb.inputJson ? JSON.parse(tb.inputJson) : {}
            } catch {
              parsedInput = { _raw: tb.inputJson }
            }
            yield {
              type: 'tool_use',
              toolName: tb.name,
              toolUseId: tb.id,
              input: parsedInput,
            }
            toolBlocks.delete(idx)
          }
          break
        }
        case 'message_delta':
          // output 累计值；input 类不取（可能发 0 覆盖掉 message_start 的值）
          if (part.usage) outputTokens = part.usage.output_tokens ?? outputTokens
          if (part.delta && 'stop_reason' in part.delta && part.delta.stop_reason) {
            stopReason = part.delta.stop_reason
          }
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
