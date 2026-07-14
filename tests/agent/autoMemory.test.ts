// tests/agent/autoMemory.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { extractMemories, autoSaveMemories } from '@/agent/autoMemory.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-automem-test-' + process.pid)
beforeEach(async () => { await mkdir(tmpDir, { recursive: true }) })
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }) })

test('提取"以后都用"偏好', () => {
  const mems = extractMemories('以后都用 bun 不要用 npm')
  expect(mems.length).toBeGreaterThan(0)
  expect(mems.some((m) => m.content.includes('bun'))).toBe(true)
})

test('提取"不要/别再"禁忌', () => {
  const mems = extractMemories('不要修改生成的代码')
  expect(mems.some((m) => m.type === 'feedback')).toBe(true)
})

test('提取"记住"', () => {
  const mems = extractMemories('记住这个 API 的 rate limit 是每分钟 60 次')
  expect(mems.some((m) => m.type === 'feedback')).toBe(true)
})

test('提取"这个项目用"项目约定', () => {
  const mems = extractMemories('这个项目用 vitest 做测试')
  expect(mems.some((m) => m.type === 'project')).toBe(true)
})

test('普通对话不提取', () => {
  const mems = extractMemories('帮我看看这个文件有什么问题')
  expect(mems.length).toBe(0)
})

test('autoSaveMemories 持久化', async () => {
  const count = await autoSaveMemories(tmpDir, '以后都用 pnpm')
  expect(count).toBeGreaterThan(0)
  // 验证文件创建
  const { loadMemories } = await import('@/instruction/memory.js')
  const loaded = await loadMemories(tmpDir)
  expect(loaded.some((m) => m.content.includes('pnpm'))).toBe(true)
})

test('太短的文本不提取', () => {
  expect(extractMemories('好的')).toEqual([])
})
