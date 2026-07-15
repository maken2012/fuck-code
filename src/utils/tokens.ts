// src/utils/tokens.ts
// token 粗估（M5 Task 2）。
//
// 不调精确 count_tokens API（M6 可加），用字符级启发式：
// - 英文（ASCII）约 4 字符/token
// - 中文（CJK 统一表意 \u4e00-\u9fff）约 1.5 字符/token
// - 混合文本按两类字符数量加权求和
//
// 用途：queryLoop 每轮开始前估算 messages 总 token，超过 getCompactThreshold 触发压缩。
import type { ChatMessage } from '@/llm/types.js'

// CJK 统一表意文字范围（最常见的中日韩汉字）
const CJK_RANGE = /[\u4e00-\u9fff]/

export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_RANGE.test(ch)) cjk++
    else other++
  }
  // 中文 1.5 字符/token，英文 4 字符/token，加权求和后向上取整
  const estimate = cjk / 1.5 + other / 4
  return Math.ceil(estimate)
}

// 估算 messages 数组总 token：对每条消息的 content 取文本估算
// - string：直接估
// - ContentBlock[]：对 text/tool_result 取其 text/content 估算；tool_use 不算（无文本量）
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const m of messages) {
    if (typeof m.content === 'string') {
      total += estimateTokens(m.content)
      continue
    }
    for (const block of m.content) {
      if (block.type === 'text') {
        total += estimateTokens(block.text)
      } else if (block.type === 'tool_result') {
        total += estimateTokens(block.content)
      } else if (block.type === 'image') {
        // v1.13: 图片按 ~1500 token/张估算（Anthropic 视觉模型典型值，防 autoCompact 失准）
        total += 1500
      }
      // tool_use 不计入（input 体积小，且难精确估算）
    }
  }
  return total
}
