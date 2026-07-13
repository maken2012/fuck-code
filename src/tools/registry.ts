// src/tools/registry.ts
// 工具注册中心。收集所有工具，供 queryLoop 使用。
// toolsToAnthropicFormat 直接用各工具自带的 jsonSchema（避免写通用 zodToJsonSchema）。
import type { Tool } from '@/tools/Tool.js'
import { ReadTool } from '@/tools/Read.js'
import { GlobTool } from '@/tools/Glob.js'
import { GrepTool } from '@/tools/Grep.js'
import { WriteTool } from '@/tools/Write.js'
import { EditTool } from '@/tools/Edit.js'
import { BashTool } from '@/tools/Bash.js'
import { TaskTool } from '@/tools/Task.js'
import { TodoWriteTool } from '@/tools/TodoWrite.js'
import { WebSearchTool } from '@/tools/WebSearch.js'
import { WebFetchTool } from '@/tools/WebFetch.js'
import { loadDynamicTools } from '@/tools/dynamicLoader.js'

// 所有内置工具
export function getAllTools(): Tool[] {
  return [
    ReadTool, GlobTool, GrepTool,           // 只读
    WriteTool, EditTool, BashTool,          // 写
    TaskTool,                               // 子 agent
    TodoWriteTool,                          // v1.1 任务跟踪
    WebSearchTool, WebFetchTool,            // v1.1 网络工具
  ]
}

// v1.1: 内置工具 + 动态加载（.fuckcode/tools/*.ts）
// 动态工具按名字去重（内置优先）
export async function getAllToolsAsync(cwd: string): Promise<Tool[]> {
  const builtin = getAllTools()
  const dynamic = await loadDynamicTools(cwd)
  const builtinNames = new Set(builtin.map((t) => t.name))
  const deduped = dynamic.filter((t) => !builtinNames.has(t.name))
  return [...builtin, ...deduped]
}

// 按名字查找工具
export function findTool(name: string, tools: Tool[]): Tool | undefined {
  return tools.find((t) => t.name === name)
}

// 转成 Anthropic API 的 tools 参数格式（name / description / input_schema）
export function toolsToAnthropicFormat(tools: Tool[]): object[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.prompt,
    input_schema: t.jsonSchema ?? { type: 'object', properties: {}, additionalProperties: true },
  }))
}
