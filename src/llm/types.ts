// src/llm/types.ts
// LLM 层事件契约。与具体 provider 无关（M2 只有 Anthropic，但保持抽象便于 M3+ 扩展）。
//
// M3：content 从纯字符串升级为 `string | ContentBlock[]`。
// - 纯文本消息（M2 兼容）仍用 string
// - 含 tool_use 的 assistant 消息、含 tool_result 的 user 消息用结构化数组
//   （Anthropic API 在工具调用场景强制要求数组形态）

// 结构化内容块。对应 Anthropic messages API 的 content 数组元素。
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string
      is_error?: boolean
    }

// 一条对话消息（Anthropic API 兼容格式）
export interface ChatMessage {
  role: 'user' | 'assistant'
  // M2: string；M3: 含 tool_use/tool_result 时用结构化数组
  content: string | ContentBlock[]
}

// 流式事件：queryLoop 和 TUI 消费这些事件
export type LlmEvent =
  | { type: 'text'; textDelta: string } // 文本片段
  | { type: 'thinking'; textDelta: string } // thinking/reasoning 片段（深度比对 #8）
  | {
      type: 'tool_use' // M3 新增：模型要求调用工具
      toolName: string
      toolUseId: string
      input: unknown
    }
  | { type: 'usage'; input: number; output: number; cacheRead: number }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; error: Error }

// 单次流式调用的结果（done 时的汇总）
export interface LlmResult {
  text: string
  stopReason: string
  usage: { input: number; output: number; cacheRead: number }
}
