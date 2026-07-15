// src/utils/tokens.ts
// token 计数。
//
// v1.18: 用 gpt-tokenizer（纯 JS BPE 分词器）精确计数，取代字符启发式。
// 对代码/JSON/中英混排比旧的"CJK 1.5 / 其他 4 字符每 token"准得多。
// 注：Claude 无公开 tokenizer，gpt-tokenizer 的 BPE 与 Claude 不完全一致，
// 但作为 autoCompact 阈值判断 + /context 占比展示已足够精确。
// image block 无法用 tokenizer 估，维持 ~1500/张启发式。
import type { ChatMessage } from '@/llm/types.js'
import { encode } from 'gpt-tokenizer'

// gpt-tokenizer 对空字符串返回空数组；encode 有最低开销，缓存避免重复计算
const cache = new Map<string, number>()
const CACHE_MAX = 500

export function estimateTokens(text: string): number {
  if (!text) return 0
  const cached = cache.get(text)
  if (cached !== undefined) return cached
  const count = encode(text).length
  if (cache.size >= CACHE_MAX) {
    // 简单淘汰：清空（避免 LRU 的复杂度，token 估算场景无所谓）
    cache.clear()
  }
  cache.set(text, count)
  return count
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
