// tests/tools/Task.test.ts
// Task 工具元数据测试。子 agent 的 queryLoop 调用逻辑已被 queryLoop.test.ts 覆盖，
// 这里只验证工具的元数据契约（name/schema/isReadOnly），不真实调 LLM。
import { test, expect } from 'bun:test'
import { TaskTool } from '@/tools/Task.js'

test('Task 工具元数据正确', () => {
  expect(TaskTool.name).toBe('Task')
  expect(TaskTool.description).toContain('子 agent')
  expect(TaskTool.prompt).toContain('subagent_type')
  expect(TaskTool.isReadOnly?.()).toBe(false) // Task 不标记只读（子 agent 可能写）
  expect(TaskTool.isConcurrencySafe?.()).toBe(false)
  expect(TaskTool.jsonSchema).toBeDefined()
})

test('Task inputSchema 接受完整入参', () => {
  const result = TaskTool.inputSchema.safeParse({
    description: '探索认证模块',
    prompt: '找到所有处理用户认证的文件',
    subagent_type: 'explore',
  })
  expect(result.success).toBe(true)
})

test('Task inputSchema 必填 description + prompt', () => {
  const missing = TaskTool.inputSchema.safeParse({ description: '只有描述' })
  expect(missing.success).toBe(false)
})

test('Task inputSchema subagent_type 只接受 explore/general', () => {
  const invalid = TaskTool.inputSchema.safeParse({
    description: '测试',
    prompt: '测试',
    subagent_type: 'invalid',
  })
  expect(invalid.success).toBe(false)
})

test('Task jsonSchema 含 description/prompt 必填 + subagent_type 枚举', () => {
  const schema = TaskTool.jsonSchema as { properties: Record<string, { enum?: string[] }>; required: string[] }
  expect(schema.required).toContain('description')
  expect(schema.required).toContain('prompt')
  expect(schema.properties.subagent_type?.enum).toEqual(['explore', 'general'])
})
