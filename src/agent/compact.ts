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

// 深度比对第 38 轮: 压缩指令精化（对标 Claude Code getCompactPrompt）
// 增加结构化格式 + 代码引用保留 + 文件路径列表
export const COMPACT_SYSTEM_PROMPT = `你是上下文压缩助手。请把以下对话历史压缩成一份结构化摘要。

# 保留内容（必须）
1. **关键决策**：做了什么决定、为什么（含被否决的方案）
2. **文件改动**：已修改/创建的文件列表 + 每个文件的改动要点（保留 file_path:line_number 引用）
3. **当前状态**：进行到哪一步、下一步要做什么
4. **用户约束**：偏好、禁忌、特殊要求
5. **关键代码片段**：重要的函数签名、配置、类型定义（不超过 3 段）

# 丢弃内容
- 寒暄、客套话、情绪表达
- 重复的信息（只保留最后一次）
- 已解决的中间讨论（只留结论）
- 工具返回的大段原始输出（只留摘要）

# 输出格式
用 markdown：
\`\`\`
## 决策
- ...

## 文件改动
- \`path/to/file.ts\`: 改了什么

## 当前状态
- 进行中：...
- 下一步：...

## 约束
- ...

## 关键代码
\`\`\`ts
// 最多 3 段最重要的代码
\`\`\`
\`\`\`

保持简洁（目标 300-800 字），但不要丢失任何关键信息。`

export interface CompactOpts {
  model: string
  apiKey?: string
  /** M6：第三方 Anthropic 兼容 API 的 baseURL（透传给 streamAnthropic） */
  apiBaseUrl?: string
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
    ...(opts.apiBaseUrl ? { apiBaseUrl: opts.apiBaseUrl } : {}),
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
