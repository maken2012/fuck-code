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

// v1.8: findRelevantMemories 测试
import { findRelevantMemories } from '@/instruction/memory.js'

test('findRelevantMemories：≤5 条全量返回', () => {
  const mems = [
    { name: 'a', description: 'a', type: 'project' as const, content: 'x', filePath: '/a' },
    { name: 'b', description: 'b', type: 'reference' as const, content: 'y', filePath: '/b' },
  ]
  expect(findRelevantMemories(mems, 'query').length).toBe(2)
})

test('findRelevantMemories：>5 条按相关性筛选', () => {
  const mems = Array.from({ length: 10 }, (_, i) => ({
    name: `mem-${i}`,
    description: i === 3 ? '关于认证模块' : `其他-${i}`,
    type: 'project' as const,
    content: i === 3 ? '认证 authentication auth' : `无关内容 ${i}`,
    filePath: `/m${i}`,
  }))
  const result = findRelevantMemories(mems, '认证', 5)
  expect(result.length).toBe(5)
  // mem-3 应该在结果里（含"认证"关键词）
  expect(result.some((m) => m.name === 'mem-3')).toBe(true)
})

test('findRelevantMemories：preference 类永远保留', () => {
  const mems = [
    ...Array.from({ length: 6 }, (_, i) => ({
      name: `p-${i}`, description: `偏好${i}`, type: 'preference' as const, content: 'x', filePath: `/p${i}`,
    })),
    {
      name: 'proj', description: '项目记忆', type: 'project' as const, content: '无关', filePath: '/proj',
    },
  ]
  const result = findRelevantMemories(mems, '完全无关的查询', 5)
  // 6 个 preference 即使超 maxResults 也尽量保留
  expect(result.filter((m) => m.type === 'preference').length).toBeGreaterThanOrEqual(4)
})

test('findRelevantMemories：英文关键词匹配', () => {
  const mems = [
    { name: 'ts', description: 'use typescript', type: 'project' as const, content: 'typescript', filePath: '/ts' },
    { name: 'py', description: 'use python', type: 'project' as const, content: 'python', filePath: '/py' },
    { name: 'go', description: 'use golang', type: 'project' as const, content: 'golang', filePath: '/go' },
    { name: 'rs', description: 'use rust', type: 'project' as const, content: 'rust', filePath: '/rs' },
    { name: 'java', description: 'use java', type: 'project' as const, content: 'java', filePath: '/java' },
    { name: 'rb', description: 'use ruby', type: 'project' as const, content: 'ruby', filePath: '/rb' },
  ]
  const result = findRelevantMemories(mems, 'how to use typescript', 3)
  expect(result.some((m) => m.name === 'ts')).toBe(true)
})
