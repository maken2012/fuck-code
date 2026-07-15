// tests/instruction/memory.delete.test.ts
// deleteMemory 测试
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadMemories, saveMemory, deleteMemory } from '@/instruction/memory.js'

const tmpCwd = resolve(process.env.TMPDIR || '/tmp', 'fc-mem-del-' + process.pid)

beforeEach(async () => { await mkdir(tmpCwd, { recursive: true }) })
afterEach(async () => { await rm(tmpCwd, { recursive: true, force: true }) })

test('saveMemory 后 deleteMemory 删除成功', async () => {
  await saveMemory(tmpCwd, 'test-pref', '测试偏好', 'preference', '用 bun 不用 npm')
  const before = await loadMemories(tmpCwd)
  expect(before.length).toBe(1)

  const deleted = await deleteMemory(tmpCwd, 'test-pref')
  expect(deleted).toBe(true)

  const after = await loadMemories(tmpCwd)
  expect(after.length).toBe(0)
})

test('deleteMemory 不存在的记忆返回 false', async () => {
  const deleted = await deleteMemory(tmpCwd, 'nonexistent')
  expect(deleted).toBe(false)
})
