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
