// src/llm/LLMClient.ts
// LLM 客户端类。封装 provider 路由 + fallback 链 + 流式调用。
// 从 provider.ts 的裸函数封装成对象，便于管理状态（如重试计数、模型切换）。
import type { ChatMessage, LlmEvent } from '@/llm/types.js'
import { streamMessage, streamMessageWithFallback, detectProvider } from '@/llm/provider.js'
import type { ProviderName } from '@/llm/provider.js'

export interface LLMCallOptions {
  model: string
  system: string
  messages: ChatMessage[]
  maxTokens?: number
  signal: AbortSignal
  apiKey?: string
  apiBaseUrl?: string
  tools?: object[]
  systemCacheable?: boolean
  provider?: ProviderName
  fallbackModels?: string[]
}

/**
 * LLM 客户端。封装：
 * 1. provider 路由（detectProvider）
 * 2. fallback 链（主模型 429 时按序切备用）
 * 3. 流式调用（统一 LlmEvent 输出）
 */
export class LLMClient {
  private callCount = 0

  constructor(
    private readonly apiKey?: string,
    private readonly apiBaseUrl?: string,
    private readonly provider?: ProviderName,
    private readonly fallbackModels?: string[],
  ) {}

  /** 流式调用 LLM，返回统一 LlmEvent 流 */
  async *stream(opts: Omit<LLMCallOptions, 'apiKey' | 'apiBaseUrl' | 'provider' | 'fallbackModels'>): AsyncGenerator<LlmEvent> {
    this.callCount++
    const fullOpts: LLMCallOptions = {
      ...opts,
      apiKey: this.apiKey,
      apiBaseUrl: this.apiBaseUrl,
      provider: this.provider,
      fallbackModels: this.fallbackModels,
    }

    if (this.fallbackModels && this.fallbackModels.length > 0) {
      yield* streamMessageWithFallback(fullOpts)
    } else {
      yield* streamMessage(fullOpts)
    }
  }

  /** 当前使用的 provider（基于 model 名判定） */
  getProvider(model: string): ProviderName {
    return detectProvider(model, this.apiBaseUrl, this.provider)
  }

  /** 调用次数（调试/统计用） */
  getCallCount(): number {
    return this.callCount
  }

  /** 工厂方法：从 config 创建 */
  static fromConfig(config: {
    apiKey?: string
    apiBaseUrl?: string
    provider?: ProviderName
    fallbackModels?: string[]
  }): LLMClient {
    return new LLMClient(config.apiKey, config.apiBaseUrl, config.provider, config.fallbackModels)
  }
}
