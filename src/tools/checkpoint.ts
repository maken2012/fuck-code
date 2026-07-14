// src/tools/checkpoint.ts
// 文件 checkpoint 系统。Edit/Write 执行前备份原文件，/rewind 可回滚。
// 照 Claude Code fileHistory 思路（简化版）。
//
// 存储：.fuckcode/checkpoints/<hash>@<timestamp> 文件副本
// 索引：.fuckcode/checkpoints/index.json（记录每次备份的 path/timestamp/checkpointPath）
//
// 流程：
// 1. Edit/Write 执行前调 checkpoint(filePath) 备份
// 2. /rewind 命令列出可回滚的文件，用户选择后恢复
import { copyFile, stat, mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import { createHash } from 'node:crypto'

export interface Checkpoint {
  id: string                  // 时间戳-based 唯一 id
  originalPath: string        // 原文件路径
  checkpointPath: string      // 备份文件路径
  timestamp: number
  size: number
}

const CHECKPOINT_DIR = '.fuckcode/checkpoints'
const INDEX_FILE = 'index.json'

// 加载索引
async function loadIndex(cwd: string): Promise<Checkpoint[]> {
  const indexPath = resolve(cwd, CHECKPOINT_DIR, INDEX_FILE)
  try {
    const raw = await readFile(indexPath, 'utf8')
    return JSON.parse(raw) as Checkpoint[]
  } catch {
    return []
  }
}

// 保存索引
// 深度比对第 26 轮: 原子写索引（对标 Session.ts writeIndex 原子策略）
async function saveIndex(cwd: string, checkpoints: Checkpoint[]): Promise<void> {
  const dir = resolve(cwd, CHECKPOINT_DIR)
  await mkdir(dir, { recursive: true })
  const finalPath = resolve(dir, INDEX_FILE)
  const tmpPath = finalPath + '.tmp'
  await writeFile(tmpPath, JSON.stringify(checkpoints, null, 2), 'utf8')
  await rename(tmpPath, finalPath)
}

// 备份文件（Edit/Write 执行前调）
export async function checkpoint(cwd: string, filePath: string): Promise<Checkpoint | null> {
  try {
    const stats = await stat(filePath)
    if (!stats.isFile()) return null
  } catch {
    return null // 文件不存在（可能是 Write 创建新文件），不备份
  }

  const timestamp = Date.now()
  const hash = createHash('sha256').update(filePath).digest('hex').slice(0, 8)
  const id = `${timestamp}-${hash}`
  const checkpointFileName = `${hash}@${timestamp}`
  const checkpointPath = resolve(cwd, CHECKPOINT_DIR, checkpointFileName)

  // 确保目录存在
  await mkdir(resolve(cwd, CHECKPOINT_DIR), { recursive: true })

  // 复制文件
  await copyFile(filePath, checkpointPath)

  const checkpoint: Checkpoint = {
    id,
    originalPath: filePath,
    checkpointPath,
    timestamp,
    size: (await stat(checkpointPath)).size,
  }

  // 深度比对第 26 轮: 同文件去重——每个文件只保留最近 5 个 checkpoint（对标 Claude Code pruning）
  const MAX_PER_FILE = 5
  const index = await loadIndex(cwd)
  index.push(checkpoint)

  // 按文件分组，每组只保留最近 MAX_PER_FILE 个
  const byFile = new Map<string, Checkpoint[]>()
  for (const cp of index) {
    const arr = byFile.get(cp.originalPath) ?? []
    arr.push(cp)
    byFile.set(cp.originalPath, arr)
  }
  const pruned: Checkpoint[] = []
  const toDelete: string[] = []
  for (const [, arr] of byFile) {
    arr.sort((a, b) => b.timestamp - a.timestamp)
    const keep = arr.slice(0, MAX_PER_FILE)
    pruned.push(...keep)
    for (const old of arr.slice(MAX_PER_FILE)) {
      toDelete.push(old.checkpointPath)
    }
  }
  // 全局上限仍保留 100 个
  pruned.sort((a, b) => b.timestamp - a.timestamp)
  const finalIndex = pruned.slice(0, 100)
  // 删除被裁剪的文件
  const { unlink } = await import('node:fs/promises')
  await Promise.allSettled(toDelete.map((p) => unlink(p).catch(() => {})))

  await saveIndex(cwd, finalIndex)

  return checkpoint
}

// 列出某文件的可回滚点（最近的在前）
export async function listCheckpoints(cwd: string, filePath?: string): Promise<Checkpoint[]> {
  const index = await loadIndex(cwd)
  const filtered = filePath ? index.filter((c) => c.originalPath === filePath) : index
  return filtered.sort((a, b) => b.timestamp - a.timestamp)
}

// 恢复到某个 checkpoint
export async function restoreCheckpoint(cwd: string, id: string): Promise<boolean> {
  const index = await loadIndex(cwd)
  const cp = index.find((c) => c.id === id)
  if (!cp) return false
  await copyFile(cp.checkpointPath, cp.originalPath)
  return true
}

// 清空所有 checkpoint（/clear-checkpoints 用）
export async function clearCheckpoints(cwd: string): Promise<number> {
  const index = await loadIndex(cwd)
  const { unlink, rm } = await import('node:fs/promises')
  await Promise.allSettled(index.map((c) => unlink(c.checkpointPath)))
  await rm(resolve(cwd, CHECKPOINT_DIR), { recursive: true, force: true }).catch(() => {})
  return index.length
}
