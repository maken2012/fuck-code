// src/services/Session.ts
// JSONL 会话持久化（M5 Task 1）。
//
// 存储布局（用 Paths.ts 解析）：
//   <projectSessionDir>/<sessionId>.jsonl   每行一个 JSON.stringify(ChatMessage)
//   <projectSessionDir>/sessions.json      SessionMeta[] 索引
//
// 关键设计：
// - 追加用 appendFile（原子、读-改-写风险低）
// - compact boundary 是特殊 user 消息：content[0].text = "<compact>...</compact>"，
//   带 _meta.compactBoundary=true 标记。loadMessages 截断到最后一个 boundary（含）。
// - sessions.json 每次更新读-改-写（小文件，可接受）
//
// ⚠️ ChatMessage.content 是 string | ContentBlock[]，JSON.stringify/parse 能处理联合，
// 读回时不需要额外类型转换（运行时结构已正确，TS 类型按 ChatMessage 标注）。
import type { ChatMessage, ContentBlock } from '@/llm/types.js'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { projectSessionDir } from '@/services/Paths.js'

export interface SessionMeta {
  id: string
  createdAt: number
  lastMessageAt: number
  title: string
  messageCount: number
}

function jsonlPath(sessionId: string, cwd: string): string {
  return resolve(projectSessionDir(cwd), `${sessionId}.jsonl`)
}

function indexPath(cwd: string): string {
  return resolve(projectSessionDir(cwd), 'sessions.json')
}

// 读 sessions.json，文件不存在/解析失败均返回空数组（不抛错）
async function readIndex(cwd: string): Promise<SessionMeta[]> {
  try {
    const raw = await readFile(indexPath(cwd), 'utf8')
    return JSON.parse(raw) as SessionMeta[]
  } catch {
    return []
  }
}

// 深度比对第 21 轮: 原子写 sessions.json（写 .tmp 再 rename，防崩溃丢索引）
import { rename, unlink } from 'node:fs/promises'
async function writeIndex(cwd: string, sessions: SessionMeta[]): Promise<void> {
  const finalPath = indexPath(cwd)
  const tmpPath = finalPath + '.tmp'
  await writeFile(tmpPath, JSON.stringify(sessions, null, 2))
  // rename 是原子的（POSIX 保证）——要么旧文件、要么新文件，不会出现半写
  await rename(tmpPath, finalPath)
  // 清理可能的旧 .tmp 残留（防跨启动泄漏）
  await unlink(tmpPath + '.old').catch(() => {})
}

// 判断一条 user 消息是否是 compact boundary（结构化 content + _meta.compactBoundary）
function isCompactBoundary(m: ChatMessage): boolean {
  if (m.role !== 'user' || typeof m.content === 'string') return false
  // content 是 ContentBlock[]，第一个 text block 带 _meta.compactBoundary
  const first = m.content[0]
  if (!first || first.type !== 'text') return false
  const meta = (first as ContentBlock & { _meta?: { compactBoundary?: boolean } })._meta
  return Boolean(meta?.compactBoundary)
}

// 创建新会话：生成 uuid + 创建空 jsonl 文件 + 写 sessions.json 索引条目
export async function createSession(cwd: string): Promise<string> {
  const id = randomUUID()
  const now = Date.now()
  const dir = projectSessionDir(cwd)
  await mkdir(dir, { recursive: true })

  // 创建空 jsonl 文件（touch）
  await writeFile(jsonlPath(id, cwd), '')

  // 追加索引条目（读-改-写）
  const sessions = await readIndex(cwd)
  const meta: SessionMeta = {
    id,
    createdAt: now,
    lastMessageAt: now,
    title: '新会话',
    messageCount: 0,
  }
  sessions.push(meta)
  await writeIndex(cwd, sessions)

  return id
}

// 追加消息到 jsonl（每行一个 JSON.stringify）。同步更新索引的 messageCount + lastMessageAt
export async function appendMessages(
  sessionId: string,
  cwd: string,
  messages: ChatMessage[],
): Promise<void> {
  // 确保目录存在（防御性，createSession 已建）
  await mkdir(projectSessionDir(cwd), { recursive: true })

  if (messages.length > 0) {
    const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
    await appendFile(jsonlPath(sessionId, cwd), lines)
  }

  // 更新索引
  const sessions = await readIndex(cwd)
  const meta = sessions.find((s) => s.id === sessionId)
  if (meta) {
    meta.messageCount += messages.length
    if (messages.length > 0) meta.lastMessageAt = Date.now()
    // 深度比对修复 #9: 首条 user 消息自动生成标题（截前 40 字）
    if (meta.title === '新会话') {
      const firstUser = messages.find((m) => m.role === 'user')
      if (firstUser) {
        const text = typeof firstUser.content === 'string'
          ? firstUser.content
          : Array.isArray(firstUser.content)
            ? (firstUser.content.find((b) => b.type === 'text') as { text?: string } | undefined)?.text ?? ''
            : ''
        if (text.trim()) {
          meta.title = text.trim().slice(0, 40) + (text.length > 40 ? '...' : '')
        }
      }
    }
    await writeIndex(cwd, sessions)
  }
}

// 加载消息：读全部行，找最后一个 compact boundary，返回它（含）之后的消息
// 深度比对第 21 轮: 增强损坏行容错——最后一行可能是半写（崩溃时）
export async function loadMessages(
  sessionId: string,
  cwd: string,
): Promise<ChatMessage[]> {
  let raw: string
  try {
    raw = await readFile(jsonlPath(sessionId, cwd), 'utf8')
  } catch {
    return [] // 文件不存在按空
  }

  const allLines = raw.split('\n').filter((l) => l.trim().length > 0)
  const messages: ChatMessage[] = []
  let skippedCount = 0
  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i]!
    try {
      messages.push(JSON.parse(line) as ChatMessage)
    } catch {
      skippedCount++
      // 深度比对第 21 轮: 最后一行半写不警告（正常——可能正在追加）
      // 中间行损坏才警告（数据损坏信号）
      if (i < allLines.length - 1) {
        // 中间行损坏——日志到 stderr
        process.stderr.write(`[WARN] 会话 ${sessionId} 第 ${i + 1} 行 JSON 损坏，已跳过\n`)
      }
    }
  }

  // 找最后一个 compact boundary 的索引
  let boundaryIdx = -1
  for (let i = 0; i < messages.length; i++) {
    if (isCompactBoundary(messages[i]!)) boundaryIdx = i
  }

  if (boundaryIdx === -1) return messages
  return messages.slice(boundaryIdx)
}

// 列出某项目的所有会话（按 lastMessageAt 倒序，最近在前）
export async function listSessions(cwd: string): Promise<SessionMeta[]> {
  const sessions = await readIndex(cwd)
  return [...sessions].sort((a, b) => b.lastMessageAt - a.lastMessageAt)
}

// 写 compact boundary：特殊 user 消息，作为压缩边界
// 格式：{"role":"user","content":[{"type":"text","text":"<compact>...</compact>","_meta":{"compactBoundary":true}}]}
export async function writeCompactBoundary(
  sessionId: string,
  cwd: string,
  summary: string,
): Promise<void> {
  const boundary: ChatMessage = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `<compact>${summary}</compact>`,
        _meta: { compactBoundary: true },
      } as ContentBlock & { _meta: { compactBoundary: boolean } },
    ],
  }
  await appendMessages(sessionId, cwd, [boundary])
}
