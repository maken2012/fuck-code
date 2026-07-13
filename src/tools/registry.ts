// src/tools/registry.ts
// 工具注册中心。收集所有工具，供 queryLoop 使用。
// toolsToAnthropicFormat 直接用各工具自带的 jsonSchema（避免写通用 zodToJsonSchema）。
import type { Tool } from '@/tools/Tool.js'
import { ReadTool } from '@/tools/Read.js'
import { GlobTool } from '@/tools/Glob.js'
import { GrepTool } from '@/tools/Grep.js'

// 所有内置工具（M3 只读三件套；M4 加 Write/Edit/Bash）
export function getAllTools(): Tool[] {
  return [ReadTool, GlobTool, GrepTool]
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
