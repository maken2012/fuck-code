// src/tools/extraDirs.ts
// 多目录工作区：额外工作目录的进程级注册表。
//
// /add-dir 命令把额外目录加进来，Glob/Grep 工具执行时遍历这些目录（+ 主 cwd）。
// 用模块级单例，避免在 ToolContext → queryLoop → ToolExecutor 整条链路穿一个新字段。
import { resolve } from 'node:path'

const extraDirs = new Set<string>()

/** 添加额外工作目录（相对路径基于 baseCwd 解析） */
export function addExtraDir(dir: string, baseCwd = process.cwd()): string {
  const abs = resolve(baseCwd, dir)
  extraDirs.add(abs)
  return abs
}

/** 获取所有额外工作目录（不含主 cwd） */
export function getExtraDirs(): string[] {
  return [...extraDirs]
}

/** 获取全部搜索目录（主 cwd + 额外目录） */
export function getAllSearchDirs(cwd = process.cwd()): string[] {
  return [cwd, ...extraDirs]
}

/** 清空（测试用） */
export function clearExtraDirs(): void {
  extraDirs.clear()
}
