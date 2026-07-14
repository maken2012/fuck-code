// src/llm/openaiCompatible.ts
// OpenAI 兼容 provider 流式封装。支持 OpenAI/DeepSeek/Ollama/vLLM 等所有
// 遵循 OpenAI Chat Completions API 的服务。
//
// 与 Anthropic 的差异：
// - 流式事件：choices[0].delta.content（文本）/ choices[0].delta.tool_calls（工具）
// - usage 在最后一个 chunk（stream_options: {include_usage: true}）或单独接口
// - system 是 messages[0] 的 role:'system'，不是独立参数
// - finish_reason：stop / length / tool_calls / content_filter
//
// v1.4：先做纯文本流式 + tool_calls 解析（与 anthropic.ts 对齐）
export interface StreamOpenAIOpts {
  model: string
  system: string
  messages: ChatMessage[]
  maxTokens?: number
  signal: AbortSignal
  reasoningEffort?: string  // 深度比对第 72 轮: reasoning_effort（low/medium/high）
  apiKey?: string
  apiBaseUrl?: string
  tools?: object[]
  _clientOverride?: { chat?: { completions?: { create: (body: object, opts?: object) => Promise<AsyncIterable<unknown>> } } }
}

import type { ChatMessage, LlmEvent } from '@/llm/types.js'

// 把 ChatMessage[] + system 转成 OpenAI messages 格式
function toOpenAIMessages(system: string, messages: ChatMessage[]): unknown[] {
  const result: unknown[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (typeof m.content === 'string') {
      result.push({ role: m.role, content: m.content })
    } else {
      // 结构化 content（含 tool_use/tool_result）：简化为文本拼接
      const text = (m.content as Array<{ type: string; text?: string; content?: string }>)
        .filter((b) => b.type === 'text' || b.type === 'tool_result')
        .map((b) => b.text ?? b.content ?? '')
        .join('\n')
      result.push({ role: m.role, content: text || '（结构化内容已简化）' })
    }
  }
  return result
}

export async function* streamOpenAICompatible(opts: StreamOpenAIOpts): AsyncGenerator<LlmEvent> {
  // 构造 client。OpenAI SDK 的 baseURL 接受自定义（兼容 Ollama/vLLM/中转）
  // 动态 import OpenAI SDK（按需加载，anthropic-only 用户不需要装）
  let client: { chat: { completions: { create: (b: object, o?: object) => Promise<AsyncIterable<unknown>> } } }
  if (opts._clientOverride?.chat?.completions?.create) {
    client = opts._clientOverride as typeof client
  } else {
    try {
      const OpenAIModule = await import('openai')
      const OpenAI = OpenAIModule.default
      client = new OpenAI({
        apiKey: opts.apiKey ?? 'dummy', // Ollama 等本地服务不需要 key，但 SDK 要非空
        baseURL: opts.apiBaseUrl ?? 'http://localhost:11434/v1',
      }) as typeof client
    } catch {
      yield { type: 'error', error: new Error('openai 包未安装。运行 bun add openai 来支持 OpenAI 兼容 provider。') }
      return
    }
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: toOpenAIMessages(opts.system, opts.messages),
    max_tokens: opts.maxTokens ?? 8192,
    stream: true,
    stream_options: { include_usage: true },
  }
  // 深度比对第 72 轮: reasoning_effort 支持（对标 opencode/OpenAI o1/o3/DeepSeek-R1）
  // 某些模型支持 reasoning_effort 参数控制推理深度
  if (opts.reasoningEffort) {
    body.reasoning_effort = opts.reasoningEffort
  }
  if (opts.tools && opts.tools.length > 0) {
    // OpenAI tools 格式与 Anthropic 略不同，v1.4 暂不深度支持（留后续）
    body.tools = opts.tools
  }

  let stream: AsyncIterable<unknown>
  try {
    stream = await client.chat.completions.create(body, { signal: opts.signal })
  } catch (e) {
    if (opts.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    yield { type: 'error', error: e as Error }
    return
  }

  let inputTokens = 0
  let outputTokens = 0
  let stopReason = 'stop'
  // tool_call 累积（按 index）
  const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>()

  try {
    for await (const chunk of stream) {
      const c = chunk as {
        choices?: Array<{
          delta?: {
            content?: string | null
            reasoning_content?: string | null
            reasoning?: string | null
            tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
          }
          finish_reason?: string | null
        }>
        usage?: { prompt_tokens?: number; completion_tokens?: number; reasoning_tokens?: number }
      }
      const choice = c.choices?.[0]
      // 深度比对第 18 轮: reasoning/thinking 支持（MiniMax-M3/o1/DeepSeek-R1 等）
      const reasoningText = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning
      if (reasoningText) {
        yield { type: 'thinking', textDelta: reasoningText }
      }
      if (choice?.delta?.content) {
        yield { type: 'text', textDelta: choice.delta.content }
      }
      if (choice?.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const existing = toolCallBuffers.get(tc.index)
          if (!existing && tc.id) {
            toolCallBuffers.set(tc.index, { id: tc.id, name: tc.function?.name ?? '', args: tc.function?.arguments ?? '' })
          } else if (existing) {
            existing.args += tc.function?.arguments ?? ''
          }
        }
      }
      if (choice?.finish_reason) {
        stopReason = choice.finish_reason
      }
      if (c.usage) {
        inputTokens = c.usage.prompt_tokens ?? 0
        outputTokens = c.usage.completion_tokens ?? 0
      }
    }
  } catch (e) {
    if (opts.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    // 深度比对第 18 轮: 友好错误提示（对标 anthropic.ts）
    const err = e as { status?: number; message?: string }
    let friendly = err.message ?? String(e)
    if (err.status === 401) {
      friendly = `OpenAI 兼容 API key 无效。检查 config.json 的 apiKey 和 apiBaseUrl。`
    } else if (err.status === 429) {
      friendly = `OpenAI 兼容 API 限流（429）。请稍后再试。`
    } else if (err.status && err.status >= 500) {
      friendly = `OpenAI 兼容 API 服务端错误（${err.status}）。服务可能暂时不可用。`
    }
    yield { type: 'error', error: new Error(friendly) }
    return
  }

  // 输出 tool_use 事件（OpenAI 把 tool_call 参数作为 JSON 字符串流式传）
  for (const [, tc] of toolCallBuffers) {
    let parsedInput: unknown = {}
    try {
      parsedInput = tc.args ? JSON.parse(tc.args) : {}
    } catch {
      parsedInput = { _raw: tc.args }
    }
    yield { type: 'tool_use', toolName: tc.name, toolUseId: tc.id, input: parsedInput }
  }

  yield { type: 'usage', input: inputTokens, output: outputTokens, cacheRead: 0 }
  // stop_reason 映射到 Anthropic 风格
  const mappedStop = stopReason === 'stop' ? 'end_turn' : stopReason === 'length' ? 'max_tokens' : stopReason === 'tool_calls' ? 'tool_use' : stopReason
  yield { type: 'done', stopReason: mappedStop }
}
