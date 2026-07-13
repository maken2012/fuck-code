// tests/tools/TodoWrite.test.ts
import { test, expect, beforeEach } from 'bun:test'
import { TodoWriteTool, getCurrentTodos } from '@/tools/TodoWrite.js'

beforeEach(() => {
  // 重置全局 todo 状态
  TodoWriteTool.execute({ todos: [] }, { cwd: '/tmp', abortSignal: new AbortController().signal, readFileState: new Map() })
})

test('创建任务列表', async () => {
  const result = await TodoWriteTool.execute(
    { todos: [
      { content: '读文件', status: 'pending' },
      { content: '改代码', status: 'pending' },
      { content: '跑测试', status: 'pending' },
    ] },
    { cwd: '/tmp', abortSignal: new AbortController().signal, readFileState: new Map() },
  )
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.data).toContain('0/3 完成')
  expect(getCurrentTodos().length).toBe(3)
})

test('同时只能一个 in_progress', async () => {
  const result = await TodoWriteTool.execute(
    { todos: [
      { content: 'A', status: 'in_progress' },
      { content: 'B', status: 'in_progress' },
    ] },
    { cwd: '/tmp', abortSignal: new AbortController().signal, readFileState: new Map() },
  )
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toContain('2')  // 当前有 2 个 in_progress
})

test('标记完成显示进度', async () => {
  const result = await TodoWriteTool.execute(
    { todos: [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress' },
      { content: 'C', status: 'pending' },
    ] },
    { cwd: '/tmp', abortSignal: new AbortController().signal, readFileState: new Map() },
  )
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.data).toContain('1/3 完成')
})

test('元数据：只读 + 并发安全', () => {
  expect(TodoWriteTool.isReadOnly?.()).toBe(true)
  expect(TodoWriteTool.isConcurrencySafe?.()).toBe(true)
})

test('inputSchema 拒绝非法 status', () => {
  const bad = TodoWriteTool.inputSchema.safeParse({ todos: [{ content: 'x', status: 'invalid' }] })
  expect(bad.success).toBe(false)
})
