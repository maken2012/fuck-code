// src/tools/dynamicLoader.ts
// 动态工具加载。扫描 .fuckcode/tools/*.{ts,js}，动态 import。
// 深度比对第 40 轮: 四阶段错误分类（对标 opencode PluginLoader install/entry/compatibility/load）
import type { Tool } from '@/tools/Tool.js'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// 深度比对第 40 轮: 加载结果含错误分类（对标 opencode PluginLoader 四阶段）
export type LoadErrorType = 'not_found' | 'import_failed' | 'invalid_export' | 'not_a_tool'

export interface LoadResult {
  tools: Tool[]
  errors: { file: string; type: LoadErrorType; message: string }[]
}

function isTool(obj: unknown): obj is Tool {
  if (!obj || typeof obj !== 'object') return false
  const t = obj as Record<string, unknown>
  return (
    typeof t.name === 'string' &&
    typeof t.description === 'string' &&
    typeof t.prompt === 'string' &&
    typeof t.execute === 'function'
  )
}

export async function loadDynamicTools(cwd: string): Promise<Tool[]> {
  const result = await loadDynamicToolsDetailed(cwd)
  // 错误输出到 stderr（对标 opencode PluginLoader 日志）
  for (const err of result.errors) {
    const hint = err.type === 'not_found'
      ? '文件不存在'
      : err.type === 'import_failed'
        ? 'import 失败（可能是语法错误或缺少依赖）'
        : err.type === 'invalid_export'
          ? '没有导出合法的 Tool（需要 default export 或 tool/tools 命名导出）'
          : '导出的对象不符合 Tool 接口（需要 name/description/prompt/execute）'
    process.stderr.write(`[WARN] 动态工具 ${err.file}: ${hint} — ${err.message}\n`)
  }
  return result.tools
}

// 深度比对第 40 轮: 详细加载（含错误分类）
export async function loadDynamicToolsDetailed(cwd: string): Promise<LoadResult> {
  const tools: Tool[] = []
  const errors: LoadResult['errors'] = []

  const toolsDir = resolve(cwd, '.fuckcode', 'tools')
  try {
    await stat(toolsDir)
  } catch {
    return { tools, errors } // 目录不存在——正常
  }

  const pattern = new Bun.Glob('*.{ts,js}')
  let files: string[] = []
  try {
    for await (const f of pattern.scan({ cwd: toolsDir, absolute: false })) {
      files.push(f)
    }
  } catch (e) {
    return { tools, errors: [{ file: toolsDir, type: 'not_found', message: (e as Error).message }] }
  }

  for (const file of files) {
    const fullPath = resolve(toolsDir, file)
    try {
      const mod = await import(pathToFileURL(fullPath).href)

      // 阶段 3: compatibility——检查导出
      const candidates: { obj: unknown; source: string }[] = []
      if (mod.default) candidates.push({ obj: mod.default, source: 'default' })
      if (mod.tool) candidates.push({ obj: mod.tool, source: 'tool' })
      if (mod.tools && Array.isArray(mod.tools)) {
        for (const t of mod.tools) candidates.push({ obj: t, source: 'tools[]' })
      }

      if (candidates.length === 0) {
        errors.push({ file, type: 'invalid_export', message: '没有 default/tool/tools 导出' })
        continue
      }

      // 阶段 4: load——验证 Tool 接口
      let loaded = false
      for (const { obj, source } of candidates) {
        if (isTool(obj)) {
          tools.push(obj)
          loaded = true
        }
      }
      if (!loaded) {
        errors.push({ file, type: 'not_a_tool', message: `导出 ${candidates.map((c) => c.source).join(', ')} 不符合 Tool 接口` })
      }
    } catch (e) {
      // 阶段 2: entry——import 失败
      errors.push({ file, type: 'import_failed', message: (e as Error).message })
    }
  }

  return { tools, errors }
}
