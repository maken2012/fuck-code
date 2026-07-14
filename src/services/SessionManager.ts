// src/services/SessionManager.ts
// 会话管理器类。封装会话持久化 + 恢复 + 压缩 + 消息管理。
// 从 Session.ts 的裸函数封装成有状态对象（持有当前 sessionId）。
import type { ChatMessage } from '@/llm/types.js'
import {
  createSession,
  loadMessages,
  appendMessages,
  listSessions,
  writeCompactBoundary,
} from '@/services/Session.js'
import type { SessionMeta } from '@/services/Session.js'

/**
 * 会话管理器。封装：
 * 1. 会话创建/恢复
 * 2. 消息持久化（JSONL 追加）
 * 3. 历史加载（含 compact boundary 截断）
 * 4. 会话列表
 */
export class SessionManager {
  private sessionId: string | null = null
  private cwd: string

  constructor(cwd: string) {
    this.cwd = cwd
  }

  /** 创建新会话 */
  async create(): Promise<string> {
    this.sessionId = await createSession(this.cwd)
    return this.sessionId
  }

  /** 当前会话 ID */
  getId(): string | null {
    return this.sessionId
  }

  /** 是否有活跃会话 */
  isActive(): boolean {
    return this.sessionId !== null
  }

  /** 追加消息到当前会话 */
  async append(messages: ChatMessage[]): Promise<void> {
    if (!this.sessionId) return
    await appendMessages(this.sessionId, this.cwd, messages)
  }

  /** 加载当前会话的历史消息（含 compact boundary 截断） */
  async loadHistory(): Promise<ChatMessage[]> {
    if (!this.sessionId) return []
    return loadMessages(this.sessionId, this.cwd)
  }

  /** 写入 compact boundary（压缩点） */
  async writeBoundary(summary: string): Promise<void> {
    if (!this.sessionId) return
    await writeCompactBoundary(this.sessionId, this.cwd, summary)
  }

  /** 列出本项目的所有历史会话 */
  async list(): Promise<SessionMeta[]> {
    return listSessions(this.cwd)
  }

  /** 恢复到指定会话 */
  async resume(sessionId: string): Promise<ChatMessage[]> {
    this.sessionId = sessionId
    return this.loadHistory()
  }
}
