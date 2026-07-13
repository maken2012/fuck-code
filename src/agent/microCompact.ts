// src/agent/microCompact.ts
// microCompact：按 tool_use_id 替换旧的大工具结果，比 autoCompact 全量摘要更精细。
// 照 Claude Code 的 microCompact.ts 思路（简化版）。
//
// 策略：在 queryLoop 每轮开始前，扫描 messages 里的 tool_result blocks，
// 把"旧的"（非最近 N 个）可压缩工具的结果内容替换成占位符。
// 保留 tool_use 结构（模型知道执行过），只清内容，省 token 且保护 cache 前缀。
//
// 可压缩工具：Read / Bash / Grep / Glob / WebFetch / WebSearch（返回大文本的工具）
import type { ChatMessage, ContentBlock } from '@/llm/types.js'

// 这些工具的结果通常很大（文件内容、命令输出、搜索结果），适合压缩
const COMPACTABLE_TOOLS = new Set(['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'])
const KEEP_RECENT = 4 // 保留最近 N 个工具结果不压缩
const PLACEHOLDER = '[Old tool result content cleared]'

export function getCompactableTools(): string[] {
  return [...COMPACTABLE_TOOLS]
}

// 执行 microCompact：原地修改 messages，返回替换了多少个
export function microCompactMessages(messages: ChatMessage[]): number {
  // 收集所有 tool_use 的 id + 对应 tool 名 + 它们的 tool_result block 位置
  interface ToolResultInfo {
    msgIdx: number
    blockIdx: number
    toolUseId: string
    toolName: string
    size: number
  }
  const toolResults: ToolResultInfo[] = []

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx]
    if (!msg || typeof msg.content === 'string') continue
    for (let blockIdx = 0; blockIdx < msg.content.length; blockIdx++) {
      const block = msg.content[blockIdx]
      if (!block || block.type !== 'tool_result') continue
      // 找对应的 tool_use 拿工具名
      const toolUseId = block.tool_use_id
      const toolName = findToolNameForId(messages, toolUseId)
      const content = typeof block.content === 'string' ? block.content : ''
      toolResults.push({
        msgIdx,
        blockIdx,
        toolUseId,
        toolName,
        size: content.length,
      })
    }
  }

  // 只压缩可压缩工具的结果，按时间顺序，保留最近 KEEP_RECENT 个
  const compactable = toolResults.filter((tr) => COMPACTABLE_TOOLS.has(tr.toolName))
  if (compactable.length <= KEEP_RECENT) return 0

  // 要压缩的：除最近 KEEP_RECENT 个之外的
  const toCompact = compactable.slice(0, compactable.length - KEEP_RECENT)

  let replacedCount = 0
  for (const tr of toCompact) {
    const msg = messages[tr.msgIdx]
    if (!msg || typeof msg.content === 'string') continue
    const block = msg.content[tr.blockIdx] as ContentBlock & { content: string }
    if (block && block.type === 'tool_result' && block.content !== PLACEHOLDER) {
      // 只在内容确实较大时才压缩（避免压缩小结果，省不了多少还破坏 cache）
      if (block.content.length > 500) {
        block.content = PLACEHOLDER
        replacedCount++
      }
    }
  }

  return replacedCount
}

// 根据 tool_use_id 找工具名（回溯 messages 找对应的 tool_use block）
function findToolNameForId(messages: ChatMessage[], toolUseId: string): string {
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id === toolUseId) {
        return block.name
      }
    }
  }
  return ''
}
