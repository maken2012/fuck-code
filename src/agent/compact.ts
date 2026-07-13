// src/agent/compact.ts
// autoCompact 摘要生成（M5 Task 3）。
//
// 作用：长对话达到阈值时，把历史消息发给 LLM 生成摘要，
// 摘要作为 compact boundary 写入 JSONL，后续 loadMessages 只返回 boundary 之后。
//
// 与 queryLoop 共享 LLM 调用约定：
// - 用 streamAnthropic（生产）或 _llmOverride（测试 mock）
// - 累积 text 事件得到摘要文本
// - system prompt 用专门的压缩指令（中文）
import type { ChatMessage, LlmEvent } from '@/llm/types.js'
import { streamAnthropic } from '@/llm/anthropic.js'

// 压缩阈值：contextWindow 留 13000 token 余量给输出 + 新输入
// 默认 200000 contextWindow → 187000 触发压缩
export function getCompactThreshold(contextWindow: number): number {
  return contextWindow - 13000
}

// 压缩指令（中文）：保留关键决策/文件改动/未完成任务，丢弃寒暄与已解决讨论
export const COMPACT_SYSTEM_PROMPT = `请把以下对话历史压缩成一份摘要，用于继续后续工作。保留：
1. 关键决策和结论
2. 已修改/创建的文件及改动要点
3. 未完成的任务和下一步计划
4. 用户的重要偏好或约束

丢弃：寒暄、重复信息、已解决的中间讨论。
用简洁的要点形式输出（不超过 500 字）。`

export interface CompactOpts {
  model: string
  apiKey?: string
  signal: AbortSignal
  /** 测试用：注入 mock streamAnthropic（与 queryLoop._llmOverride 同签名） */
  _llmOverride?: (opts: object) => AsyncGenerator<LlmEvent>
}

// 把历史消息发给 LLM 生成摘要，返回摘要文本。
// 实现：用压缩 system prompt，把 messages 原样转发，累积 text 事件。
export async function compactConversation(
  messages: ChatMessage[],
  opts: CompactOpts,
): Promise<string> {
  const streamFn =
    opts._llmOverride ??
    (streamAnthropic as (o: object) => AsyncGenerator<LlmEvent>)

  const streamOpts: Record<string, unknown> = {
    model: opts.model,
    system: COMPACT_SYSTEM_PROMPT,
    messages,
    signal: opts.signal,
    apiKey: opts.apiKey,
  }

  let summary = ''
  for await (const event of streamFn(streamOpts)) {
    if (event.type === 'text') {
      summary += event.textDelta
    }
    // usage / done / error 不影响摘要文本累积
  }
  return summary
}
