// tests/tools/Read.test.ts
// Read 工具测试：cat -n 行号格式 / offset+limit / 错误处理 / 只读标记
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ReadTool } from '@/tools/Read.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-read-test-' + process.pid)
const ctx = {
  cwd: tmpDir,
  abortSignal: new AbortController().signal,
  readFileState: new Map<string, { mtime: number; readAt: number }>(),
}

beforeEach(async () => {
  await mkdir(tmpDir, { recursive: true })
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

test('读取存在的文件（验证 cat -n 行号格式：6 位数字 + tab）', async () => {
  const filePath = resolve(tmpDir, 'foo.ts')
  await writeFile(filePath, 'const x = 1\nconst y = 2\n')
  const result = await ReadTool.execute({ file_path: filePath }, ctx)
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(typeof result.data).toBe('string')
    expect(result.data as string).toContain('const x = 1')
    // 行号格式：6 位右对齐 + tab + 内容（第一行 = "     1\tconst x = 1"）
    expect(result.data as string).toMatch(/ {5}1\tconst x = 1/)
    expect(result.data as string).toMatch(/ {5}2\tconst y = 2/)
  }
})

test('文件不存在返回错误', async () => {
  const result = await ReadTool.execute({ file_path: resolve(tmpDir, 'nope.ts') }, ctx)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toMatch(/不存在|not exist|ENOENT/i)
})

test('支持 offset + limit', async () => {
  const filePath = resolve(tmpDir, 'lines.txt')
  await writeFile(filePath, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'))
  const result = await ReadTool.execute({ file_path: filePath, offset: 10, limit: 5 }, ctx)
  expect(result.ok).toBe(true)
  if (result.ok) {
    const data = result.data as string
    expect(data).toContain('line 10')
    expect(data).toContain('line 14')
    expect(data).not.toContain('line 15') // limit 5: 第 10-14 行
    expect(data).not.toContain('line 9')
  }
})

test('默认读前 2000 行', async () => {
  const filePath = resolve(tmpDir, 'big.txt')
  await writeFile(filePath, Array.from({ length: 3000 }, (_, i) => `L${i + 1}`).join('\n'))
  const result = await ReadTool.execute({ file_path: filePath }, ctx)
  expect(result.ok).toBe(true)
  if (result.ok) {
    const data = result.data as string
    expect(data).toContain('L1')
    expect(data).toContain('L2000')
    expect(data).not.toContain('L2001') // 2000 行截断
  }
})

test('末尾包含统计行（共 N 行）', async () => {
  const filePath = resolve(tmpDir, 'small.ts')
  await writeFile(filePath, 'a\nb\nc\n')
  const result = await ReadTool.execute({ file_path: filePath }, ctx)
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.data as string).toMatch(/共\s*3\s*行/)
  }
})

test('读目录返回错误', async () => {
  const result = await ReadTool.execute({ file_path: tmpDir }, ctx)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toMatch(/目录|directory|不是文件/i)
})

test('isReadOnly 和 isConcurrencySafe 都是 true', () => {
  expect(ReadTool.isReadOnly?.()).toBe(true)
  expect(ReadTool.isConcurrencySafe?.()).toBe(true)
})

test('读完后更新 readFileState（记录 mtime + readAt，供 Edit/Write 校验）', async () => {
  const filePath = resolve(tmpDir, 'stateful.ts')
  await writeFile(filePath, 'export const x = 1\n')
  const localCtx = {
    cwd: tmpDir,
    abortSignal: new AbortController().signal,
    readFileState: new Map<string, { mtime: number; readAt: number }>(),
  }
  await ReadTool.execute({ file_path: filePath }, localCtx)
  const state = localCtx.readFileState.get(filePath)
  expect(state).toBeDefined()
  if (state) {
    expect(typeof state.mtime).toBe('number')
    expect(state.mtime).toBeGreaterThan(0)
    expect(state.readAt).toBeLessThanOrEqual(Date.now())
  }
})
