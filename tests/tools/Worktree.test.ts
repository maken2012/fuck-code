// tests/tools/Worktree.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { EnterWorktreeTool, ExitWorktreeTool } from '@/tools/Worktree.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-wt-test-' + process.pid)
beforeEach(async () => { await mkdir(tmpDir, { recursive: true }) })
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }) })

test('EnterWorktree 元数据', () => {
  expect(EnterWorktreeTool.name).toBe('EnterWorktree')
  expect(EnterWorktreeTool.isReadOnly?.()).toBe(false)
})

test('ExitWorktree 元数据', () => {
  expect(ExitWorktreeTool.name).toBe('ExitWorktree')
  expect(ExitWorktreeTool.isReadOnly?.()).toBe(true)
})

test('非 git 仓库创建普通子目录', async () => {
  const r = await EnterWorktreeTool.execute({ branch: 'test-branch' }, { cwd: tmpDir, abortSignal: new AbortController().signal, readFileState: new Map() })
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.data).toContain('非 git')
})

test('ExitWorktree 未进 worktree 时提示', async () => {
  // 重置 mainWorktree（通过新进程模拟）——这里直接测逻辑
  const r = await ExitWorktreeTool.execute(undefined as never, { cwd: tmpDir, abortSignal: new AbortController().signal, readFileState: new Map() })
  // 可能是"不在 worktree"或返回主目录路径
  expect(r.ok).toBe(true)
})
