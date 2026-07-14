// src/tools/_readFileState.ts
// 跨工具共享的"文件已读"状态。Edit/Write 执行前校验：必须先 Read 且文件未被外部修改。
//
// 深度比对第 29 轮: LRU 上限（对标 Claude Code 16MB file edit read cache）
export interface FileReadState {
  mtime: number // 上次 Read 时的文件 mtimeMs
  readAt: number // 时间戳（Date.now()）
  readRange?: string // 深度比对第 36 轮: 读取的 offset:limit（重复读取去重用）
  lastContent?: string // 深度比对第 41 轮: 上次读取的内容（mtime 容差用，只缓存小文件）
}
export type ReadFileState = Map<string, FileReadState>

// readFileState LRU 裁剪——超过 MAX 时删除最久未读的条目
const MAX_READ_FILE_CACHE = 200

export function pruneReadFileState(state: ReadFileState): void {
  if (state.size <= MAX_READ_FILE_CACHE) return
  const entries = [...state.entries()].sort((a, b) => (a[1]?.readAt ?? 0) - (b[1]?.readAt ?? 0))
  const toRemove = entries.length - MAX_READ_FILE_CACHE
  for (let i = 0; i < toRemove; i++) {
    const key = entries[i]?.[0]
    if (key) state.delete(key)
  }
}
