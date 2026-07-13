// src/tools/dynamicLoader.ts
// 动态工具加载。扫描 .fuckcode/tools/*.ts，动态 import，
// 如果文件 default export 或命名 export 是合法的 Tool 对象，就注册。
// 照搬 opencode 的动态加载思路（简化版）。
//
// 安全注意：动态 import 用户代码有风险（任意执行）。M1 版信任本地 .fuckcode/ 目录
//（和 AGENTS.md 同级，由用户/团队自己放）。生产环境应加白名单/沙箱。
import type { Tool } from '@/tools/Tool.js'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

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
  const toolsDir = resolve(cwd, '.fuckcode', 'tools')
  try {
    await stat(toolsDir)
  } catch {
    return [] // 目录不存在
  }

  const tools: Tool[] = []
  const pattern = new Bun.Glob('*.{ts,js}')
  try {
    for await (const file of pattern.scan({ cwd: toolsDir, absolute: false })) {
      const fullPath = resolve(toolsDir, file)
      try {
        const mod = await import(pathToFileURL(fullPath).href)
        // 检查 default export
        if (isTool(mod.default)) {
          tools.push(mod.default)
          continue
        }
        // 检查命名 export（tool / tools）
        if (isTool(mod.tool)) {
          tools.push(mod.tool)
        }
        if (Array.isArray(mod.tools)) {
          for (const t of mod.tools) {
            if (isTool(t)) tools.push(t)
          }
        }
      } catch {
        // 单个工具加载失败跳过（不阻塞整个 registry）
      }
    }
  } catch {
    // glob 扫描失败返回空
  }
  return tools
}
