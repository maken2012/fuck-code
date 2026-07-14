// src/repl/MessageHistory.ts
// 对话历史管理类。封装 Repl 里的 chatHistoryRef + setHistory + 持久化逻辑。
// 单一职责：管理显示历史（DisplayMessage）和对话上下文（ChatMessage）。
import type { ChatMessage } from '@/llm/types.js'

export interface DisplayMessage {
  role: 'user' | 'assistant'
  text: string
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
