// src/llm/provider.ts
// Provider 抽象层。根据 model 名/config 决定用哪个 provider 的 stream 函数。
// 设计：所有 provider 的 stream 函数返回统一 AsyncGenerator<LlmEvent>。
// 这层让 fuckcode 支持 Anthropic + OpenAI 兼容（OpenAI/DeepSeek/Ollama/vLLM 等）。
//
// 判定规则（model 名优先）：
// - 含 "claude" → Anthropic
// - 含 "gpt"/"o1"/"o3" → OpenAI
// - 其他 → 看 config.apiBaseUrl 是否含 anthropic.com（是则 Anthropic，否则 OpenAI 兼容）
// - 可被 config.provider 显式覆盖（'anthropic' | 'openai' | 'openai-compatible'）
import type { ChatMessage, LlmEvent } from '@/llm/types.js'
import { streamAnthropic } from '@/llm/anthropic.js'
import { streamOpenAICompatible } from '@/llm/openaiCompatible.js'

export type ProviderName = 'anthropic' | 'openai' | 'openai-compatible'

export interface StreamOpts {
  model: string
  system: string
  messages: ChatMessage[]
  maxTokens?: number
  signal: AbortSignal
  apiKey?: string
  apiBaseUrl?: string
  tools?: object[]
  systemCacheable?: boolean
  /** 显式指定 provider（覆盖自动判定） */
  provider?: ProviderName
  /** 测试用：注入 mock */
  _clientOverride?: unknown
}

// 自动判定 provider
export function detectProvider(model: string, apiBaseUrl?: string, explicit?: ProviderName): ProviderName {
  if (explicit) return explicit
  const m = model.toLowerCase()
  if (m.includes('claude')) return 'anthropic'
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 'openai'
  // 未知模型：看 baseURL
  if (apiBaseUrl) {
    const url = apiBaseUrl.toLowerCase()
    if (url.includes('anthropic.com')) return 'anthropic'
    return 'openai-compatible' // 代理/中转/Ollama/vLLM 等
  }
  // 无 baseURL 默认 anthropic（向后兼容）
  return 'anthropic'
}

// 统一 stream 入口：路由到对应 provider
export async function* streamMessage(opts: StreamOpts): AsyncGenerator<LlmEvent> {
  const provider = detectProvider(opts.model, opts.apiBaseUrl, opts.provider)

  switch (provider) {
    case 'anthropic':
      yield* streamAnthropic({
        model: opts.model,
        system: opts.system,
        messages: opts.messages,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
        apiKey: opts.apiKey,
        apiBaseUrl: opts.apiBaseUrl,
        tools: opts.tools,
        systemCacheable: opts.systemCacheable,
        _clientOverride: opts._clientOverride as never,
      })
      return
    case 'openai':
    case 'openai-compatible':
      yield* streamOpenAICompatible({
        model: opts.model,
        system: opts.system,
        messages: opts.messages,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
        apiKey: opts.apiKey,
        apiBaseUrl: opts.apiBaseUrl,
        tools: opts.tools,
        _clientOverride: opts._clientOverride as never,
      })
      return
  }
}

// v1.11: fallbackModel 链。主模型 429/overloaded 时按序尝试备用模型。
// 检测：streamMessage 第一个事件若是 error 且 message 含 429/overloaded/rate_limit，切下一个。
export async function* streamMessageWithFallback(
  opts: StreamOpts & { fallbackModels?: string[]; _streamOverride?: (o: StreamOpts) => AsyncGenerator<LlmEvent> },
): AsyncGenerator<LlmEvent> {
  const streamFn = opts._streamOverride ?? streamMessage
  const models = [opts.model, ...(opts.fallbackModels ?? [])]
  let lastError: LlmEvent | null = null

  for (let i = 0; i < models.length; i++) {
    const model = models[i]!
    if (i > 0) {
      // 通知上层正在切换（作为 text 事件，用户可见）
      yield { type: 'text', textDelta: `\n\n[主模型过载，切换到备用模型 ${model}...]\n\n` }
    }

    let gotRealEvent = false // 是否已收到非 error 事件（说明连接成功）
    const buffer: LlmEvent[] = [] // 缓存首个 error 后的事件（如果成功则重放）

    try {
      for await (const event of streamFn({ ...opts, model })) {
        if (event.type === 'error' && !gotRealEvent) {
          // 首事件就是 error——可能是 429/overloaded
          const msg = event.error.message.toLowerCase()
          const isOverload = msg.includes('429') || msg.includes('overload') || msg.includes('rate_limit') || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('503')
          if (isOverload && i < models.length - 1) {
            lastError = event
            break // 试下一个 model
          }
          // 非 overload 错误或最后一个 model——直接传播
          yield event
          return
        }
        gotRealEvent = true
        buffer.push(event)
      }

      // 如果走到这里且 gotRealEvent，说明这个 model 成功了——重放 buffer
      if (gotRealEvent) {
        for (const e of buffer) yield e
        return
      }
    } catch (e) {
      if (i < models.length - 1) {
        lastError = { type: 'error', error: e as Error }
        continue
      }
      yield { type: 'error', error: e as Error }
      return
    }
  }

  // 所有 model 都失败
  yield lastError ?? { type: 'error', error: new Error('所有模型（含备用）均失败') }
}
