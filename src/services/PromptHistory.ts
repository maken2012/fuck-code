// src/services/PromptHistory.ts
// 输入历史持久化（跨会话）。照 Claude Code history.ts 思路（简化版）。
// 存储在 ~/.fuckcode/history.jsonl，每行一条 prompt（按 projectHash 分组）。
// ↑↓ 键浏览，最多保留 1000 条/项目。
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fuckcodeDir, projectHash } from '@/services/Paths.js'

const MAX_HISTORY = 1000

// 历史文件路径：~/.fuckcode/history/<projectHash>.jsonl
function historyPath(cwd: string): string {
  return resolve(fuckcodeDir(), 'history', `${projectHash(cwd)}.jsonl`)
}

// 加载历史（最近在前）
export async function loadPromptHistory(cwd: string): Promise<string[]> {
  const path = historyPath(cwd)
  try {
    const raw = await readFile(path, 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim())
    // jsonl 每行是 JSON 字符串（含 timestamp + text），取 text
    const entries = lines.map((l) => {
      try {
        return JSON.parse(l) as { text: string; ts: number }
      } catch {
        return { text: l, ts: 0 }
      }
    })
    // 最近在前（文件是追加的，末尾最新）
    return entries.reverse().map((e) => e.text)
  } catch {
    return []
  }
}

// 追加一条历史（去重连续相同项）
export async function appendPromptHistory(cwd: string, text: string): Promise<void> {
  if (!text.trim()) return
  const path = historyPath(cwd)
  const dir = resolve(fuckcodeDir(), 'history')
  await mkdir(dir, { recursive: true })

  // 读现有历史检查最后一条是否相同（去重连续）
  const existing = await loadPromptHistory(cwd)
  if (existing[0] === text) return

  const entry = JSON.stringify({ text, ts: Date.now() })
  await appendFile(path, entry + '\n', 'utf8')

  // 超过上限裁剪（保留最近 MAX_HISTORY 条）
  if (existing.length + 1 > MAX_HISTORY) {
    const recent = [text, ...existing].slice(0, MAX_HISTORY)
    const lines = recent.slice().reverse().map((t) => JSON.stringify({ text: t, ts: Date.now() }))
    await writeFile(path, lines.join('\n') + '\n', 'utf8')
  }
}
