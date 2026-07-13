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

// 所有内置工具（只读三件套 + 写工具三件套 + v0.2c Task 子 agent）
export function getAllTools(): Tool[] {
  return [ReadTool, GlobTool, GrepTool, WriteTool, EditTool, BashTool, TaskTool]
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
