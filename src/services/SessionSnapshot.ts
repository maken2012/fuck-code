// src/services/SessionSnapshot.ts
// 会话快照 + revert + share 导出（对标 opencode snapshot/revert + share）
// 深度比对第 54 轮: opencode 特有功能
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ChatMessage } from '@/llm/types.js'
import { loadMessages } from '@/services/Session.js'
import { projectSessionDir } from '@/services/Paths.js'

export interface Snapshot {
  sessionId: string
  messageId: string  // 快照点对应的消息 ID
  createdAt: number
  label: string       // 用户可读标签
  filePath: string    // 快照文件路径
}

// 创建会话快照（保存当前 messages 到快照文件）
export async function createSnapshot(
  sessionId: string,
  cwd: string,
  messages: ChatMessage[],
  label: string,
): Promise<Snapshot> {
  const snapshotDir = resolve(projectSessionDir(cwd), 'snapshots')
  await mkdir(snapshotDir, { recursive: true })
  const timestamp = Date.now()
  const fileName = `${sessionId}-${timestamp}.json`
  const filePath = resolve(snapshotDir, fileName)
  await writeFile(filePath, JSON.stringify({
    sessionId,
    createdAt: timestamp,
    label,
    messages,
  }, null, 2), 'utf8')
  return {
    sessionId,
    messageId: `snap-${timestamp}`,
    createdAt: timestamp,
    label,
    filePath,
  }
}

// 列出会话快照
export async function listSnapshots(sessionId: string, cwd: string): Promise<Snapshot[]> {
  const snapshotDir = resolve(projectSessionDir(cwd), 'snapshots')
  try {
    await stat(snapshotDir)
  } catch {
    return []
  }
  const pattern = new Bun.Glob(`${sessionId}-*.json`)
  const snapshots: Snapshot[] = []
  try {
    for await (const file of pattern.scan({ cwd: snapshotDir, absolute: false })) {
      const fullPath = resolve(snapshotDir, file)
      try {
        const data = JSON.parse(await readFile(fullPath, 'utf8')) as Snapshot & { messages: ChatMessage[] }
        snapshots.push({
          sessionId: data.sessionId,
          messageId: data.messageId ?? `snap-${data.createdAt}`,
          createdAt: data.createdAt,
          label: data.label,
          filePath: fullPath,
        })
      } catch { /* skip */ }
    }
  } catch { /* glob fail */ }
  return snapshots.sort((a, b) => b.createdAt - a.createdAt)
}

// 从快照恢复（返回快照点的 messages）
export async function restoreSnapshot(snapshot: Snapshot): Promise<ChatMessage[]> {
  const data = JSON.parse(await readFile(snapshot.filePath, 'utf8')) as { messages: ChatMessage[] }
  return data.messages
}

// 导出会话为可分享的 markdown（对标 opencode share）
export async function exportSessionMarkdown(
  sessionId: string,
  cwd: string,
): Promise<string> {
  const messages = await loadMessages(sessionId, cwd)
  const lines: string[] = [
    `# fuckcode 会话导出`,
    ``,
    `> 导出时间：${new Date().toLocaleString('zh-CN')}`,
    `> 会话 ID：${sessionId}`,
    ``,
    `---`,
    ``,
  ]
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      const prefix = msg.role === 'user' ? '> **你**' : '**fuckcode**'
      lines.push(`${prefix}: ${msg.content}`, ``)
    } else {
      for (const block of msg.content) {
        if (block.type === 'text') {
          const prefix = msg.role === 'user' ? '> **你**' : '**fuckcode**'
          lines.push(`${prefix}: ${block.text}`, ``)
        } else if (block.type === 'tool_use') {
          lines.push(`  *工具调用: ${block.name}*`, ``)
        } else if (block.type === 'tool_result') {
          const preview = block.content.slice(0, 200)
          lines.push(`  \`\`\`\n  ${preview}\n  \`\`\``, ``)
        }
      }
    }
  }
  return lines.join('\n')
}
