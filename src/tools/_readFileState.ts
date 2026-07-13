// src/tools/_readFileState.ts
// 跨工具共享的"文件已读"状态。Edit/Write 执行前校验：必须先 Read 且文件未被外部修改。
//
// 放在 ToolContext 里，跨工具共享同一个 Map 实例。
// Read 工具读完更新它；Edit/Write 执行前校验它（hard guard）。
export interface FileReadState {
  mtime: number // 上次 Read 时的文件 mtimeMs
  readAt: number // 时间戳（Date.now()）
}
export type ReadFileState = Map<string, FileReadState>
