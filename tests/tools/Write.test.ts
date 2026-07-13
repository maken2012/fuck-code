// tests/tools/Write.test.ts
// Write 工具测试：正常写入 / 未读拒绝 / 原子写（无中间残留）/ 写入后状态更新 / 只读标记
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { WriteTool } from '@/tools/Write.js'
import { ReadTool } from '@/tools/Read.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-write-test-' + process.pid)

function makeCtx() {
  return {
    cwd: tmpDir,
    abortSignal: new AbortController().signal,
    readFileState: new Map<string, { mtime: number; readAt: number }>(),
  }
}

beforeEach(async () => {
  await mkdir(tmpDir, { recursive: true })
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

test('已读后写入成功，内容正确', async () => {
  const ctx = makeCtx()
  const filePath = resolve(tmpDir, 'a.ts')
  await writeFile(filePath, 'old\n')
  await ReadTool.execute({ file_path: filePath }, ctx)

  const result = await WriteTool.execute({ file_path: filePath, content: 'new content\n' }, ctx)
  expect(result.ok).toBe(true)
  const written = await readFile(filePath, 'utf8')
  expect(written).toBe('new content\n')
})

test('未读直接写：拒绝（hard guard）', async () => {
  const ctx = makeCtx()
  const filePath = resolve(tmpDir, 'unread.ts')
  await writeFile(filePath, 'old\n')

  const result = await WriteTool.execute({ file_path: filePath, content: 'new\n' }, ctx)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toMatch(/Read|读/i)
  // 原文件未被改动
  expect(await readFile(filePath, 'utf8')).toBe('old\n')
})

test('原子写：写完后不留 .tmp 残留文件', async () => {
  const ctx = makeCtx()
  const filePath = resolve(tmpDir, 'atomic.ts')
  await writeFile(filePath, 'init\n')
  await ReadTool.execute({ file_path: filePath }, ctx)

  await WriteTool.execute({ file_path: filePath, content: 'replaced\n' }, ctx)
  // tmp 目录里不应有 .tmp.* 残留
  const entries = await (await import('node:fs/promises')).readdir(tmpDir)
  const tmpLeftovers = entries.filter((n) => n.includes('.tmp.'))
  expect(tmpLeftovers).toEqual([])
})

test('写入后 readFileState 更新（mtime 推进）', async () => {
  const ctx = makeCtx()
  const filePath = resolve(tmpDir, 'state.ts')
  await writeFile(filePath, 'v1\n')
  await ReadTool.execute({ file_path: filePath }, ctx)
  const beforeState = ctx.readFileState.get(filePath)!
  expect(beforeState).toBeDefined()

  // 写入会改变 mtime
  const result = await WriteTool.execute({ file_path: filePath, content: 'v2\n' }, ctx)
  expect(result.ok).toBe(true)

  const afterState = ctx.readFileState.get(filePath)!
  expect(afterState).toBeDefined()
  const newMtime = (await stat(filePath)).mtimeMs
  expect(afterState.mtime).toBe(newMtime)
})

test('isReadOnly=false, isConcurrencySafe=false', () => {
  expect(WriteTool.isReadOnly?.()).toBe(false)
  expect(WriteTool.isConcurrencySafe?.()).toBe(false)
})

test('写不存在的文件（已读但被删）返回错误而非崩溃', async () => {
  const ctx = makeCtx()
  const filePath = resolve(tmpDir, 'ghost.ts')
  await writeFile(filePath, 'x\n')
  await ReadTool.execute({ file_path: filePath }, ctx)
  await rm(filePath, { force: true })
  expect(existsSync(filePath)).toBe(false)

  const result = await WriteTool.execute({ file_path: filePath, content: 'recreated\n' }, ctx)
  // 写一个全新路径其实是允许的（Write 不要求文件存在，只要求已读过该路径）。
  // 但既然之前 read 过、文件被删，重新写应能成功创建。
  expect(result.ok).toBe(true)
})
