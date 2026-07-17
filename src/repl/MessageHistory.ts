// src/repl/MessageHistory.ts
// 对话历史管理类。封装 Repl 里的 chatHistoryRef + setHistory + 持久化逻辑。
// 单一职责：管理显示历史（DisplayMessage）和对话上下文（ChatMessage）。
import type { ChatMessage } from '@/llm/types.js'
import type { DiffLine } from '@/utils/diff.js'

export interface DiffEntry {
  file: string
  stats: string
  lines: DiffLine[]
}

export interface TokenBreakdown {
  total: number
  contextWindow: number
  user: number
  assistant: number
  toolResult: number
}

// v1.18: DisplayMessage 扩展结构化字段（kind 区分渲染类型）
// 不带 kind 或 kind='text' → 纯文本（兼容现有逻辑）
export interface DisplayMessage {
  role: 'user' | 'assistant'
  text: string
  kind?: 'text' | 'diff' | 'dashboard' | 'thinking'
  diffs?: DiffEntry[]
  tokens?: TokenBreakdown
  /** v1.19: thinking 消息的完整文本（折叠时只显示字数，展开显示全文） */
  thinkingText?: string
  /** v1.19: thinking 是否展开 */
  expanded?: boolean
}

/**
 * 对话历史管理器。分离两类历史：
 * - displayHistory: UI 显示用的消息列表（含工具调用提示等）
 * - chatHistory: 给 LLM 的真实对话上下文（纯文本摘要）
 */
export class MessageHistory {
  private displayMessages: DisplayMessage[] = []
  private chatMessages: ChatMessage[] = []

  /** 获取显示历史 */
  getDisplay(): DisplayMessage[] {
    return [...this.displayMessages]
  }

  /** 获取对话上下文 */
  getChat(): ChatMessage[] {
    return [...this.chatMessages]
  }

  /** 设置全部显示历史（用于 /clear、Ctrl+L） */
  setDisplay(messages: DisplayMessage[]): void {
    this.displayMessages = [...messages]
  }

  /** 追加一条显示消息 */
  appendDisplay(message: DisplayMessage): void {
    this.displayMessages = [...this.displayMessages, message]
  }

  /** 追加多条显示消息 */
  appendDisplayBatch(messages: DisplayMessage[]): void {
    this.displayMessages = [...this.displayMessages, ...messages]
  }

  /** 更新最后一条 assistant 消息的文本（流式累积） */
  updateLastAssistant(text: string): void {
    if (this.displayMessages.length === 0) return
    const last = this.displayMessages[this.displayMessages.length - 1]
    if (last && last.role === 'assistant') {
      this.displayMessages = [
        ...this.displayMessages.slice(0, -1),
        { role: 'assistant', text },
      ]
    }
  }

  /** 记录一轮对话到 chatHistory（给 LLM 用） */
  recordTurn(userInput: string, assistantResponse: string): void {
    this.chatMessages = [
      ...this.chatMessages,
      { role: 'user', content: userInput },
      { role: 'assistant', content: assistantResponse },
    ]
  }

  /** 清空对话上下文（保留显示历史） */
  clearChat(): void {
    this.chatMessages = []
  }

  /** 全部清空 */
  clearAll(): void {
    this.displayMessages = []
    this.chatMessages = []
  }

  /** 恢复历史（/resume 用） */
  restore(messages: ChatMessage[]): void {
    this.chatMessages = [...messages]
    this.displayMessages = messages.map((m) => ({
      role: m.role,
      text: typeof m.content === 'string' ? m.content : '(结构化内容)',
    }))
  }
}
