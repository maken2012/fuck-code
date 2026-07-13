// src/llm/types.ts
// LLM 层事件契约。与具体 provider 无关（M2 只有 Anthropic，但保持抽象便于 M3+ 扩展）。

// 一条对话消息（Anthropic API 兼容格式）
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

// 流式事件：queryLoop 和 TUI 消费这些事件
export type LlmEvent =
  | { type: 'text'; textDelta: string } // 文本片段
  | { type: 'usage'; input: number; output: number; cacheRead: number }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; error: Error }

// 单次流式调用的结果（done 时的汇总）
export interface LlmResult {
  text: string
  stopReason: string
  usage: { input: number; output: number; cacheRead: number }
}
