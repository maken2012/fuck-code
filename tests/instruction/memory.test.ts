// tests/instruction/memory.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadMemories, formatMemoriesForPrompt, saveMemory } from '@/instruction/memory.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-mem-test-' + process.pid)

beforeEach(async () => {
  await mkdir(resolve(tmpDir, '.fuckcode', 'memory'), { recursive: true })
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

test('无记忆目录返回空', async () => {
  expect(await loadMemories('/tmp/nonexistent-fc-mem-xyz')).toEqual([])
})

test('加载记忆文件', async () => {
  await writeFile(
    resolve(tmpDir, '.fuckcode', 'memory', 'use-bun.md'),
    `---
name: use-bun
description: 用 bun 不用 npm
type: preference
---

这个项目统一用 bun 作为包管理器和运行时，不要用 npm。`,
  )
  const mems = await loadMemories(tmpDir)
  expect(mems.length).toBe(1)
  expect(mems[0]?.name).toBe('use-bun')
  expect(mems[0]?.description).toContain('bun')
  expect(mems[0]?.type).toBe('preference')
})

test('跳过 MEMORY.md 索引文件', async () => {
  await writeFile(resolve(tmpDir, '.fuckcode', 'memory', 'MEMORY.md'), '# 索引')
  await writeFile(
    resolve(tmpDir, '.fuckcode', 'memory', 'real.md'),
    '---\nname: real\ndescription: 真记忆\ntype: project\n---\n内容',
  )
  const mems = await loadMemories(tmpDir)
  expect(mems.length).toBe(1)
  expect(mems[0]?.name).toBe('real')
})

test('formatMemoriesForPrompt 格式化', () => {
  const formatted = formatMemoriesForPrompt([
    { name: 'x', description: 'desc', type: 'preference', content: 'content', filePath: '/x' },
  ])
  expect(formatted).toContain('记忆')
  expect(formatted).toContain('偏好')
  expect(formatted).toContain('x')
  expect(formatted).toContain('desc')
})

test('formatMemoriesForPrompt 空数组返回空字符串', () => {
  expect(formatMemoriesForPrompt([])).toBe('')
})

test('saveMemory 创建文件', async () => {
  const path = await saveMemory(tmpDir, 'test-mem', '测试', 'feedback', '内容')
  await stat(path) // 不抛错即存在
  const mems = await loadMemories(tmpDir)
  expect(mems[0]?.name).toBe('test-mem')
  expect(mems[0]?.type).toBe('feedback')
})
