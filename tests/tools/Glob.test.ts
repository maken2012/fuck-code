// tests/tools/Glob.test.ts
// Glob 工具测试：递归匹配 / 子目录 / 无匹配 / 只读标记
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { GlobTool } from '@/tools/Glob.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-glob-test-' + process.pid)
const ctx = { cwd: tmpDir, abortSignal: new AbortController().signal }

beforeEach(async () => {
  await mkdir(tmpDir, { recursive: true })
  await mkdir(resolve(tmpDir, 'sub'), { recursive: true })
  await writeFile(resolve(tmpDir, 'a.ts'), 'export const a = 1\n')
  await writeFile(resolve(tmpDir, 'b.ts'), 'export const b = 2\n')
  await writeFile(resolve(tmpDir, 'readme.md'), '# readme\n')
  await writeFile(resolve(tmpDir, 'sub', 'c.ts'), 'export const c = 3\n')
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

test('匹配所有 .ts 文件（含子目录）', async () => {
  const result = await GlobTool.execute({ pattern: '**/*.ts' }, ctx)
  expect(result.ok).toBe(true)
  if (result.ok) {
    const data = result.data as string
    expect(data).toContain('a.ts')
    expect(data).toContain('b.ts')
    expect(data).toContain('sub/c.ts') // 递归子目录
    expect(data).not.toContain('readme.md')
  }
})

test('顶层精确匹配', async () => {
  const result = await GlobTool.execute({ pattern: '*.md' }, ctx)
  expect(result.ok).toBe(true)
  if (result.ok) {
    const data = result.data as string
    expect(data).toContain('readme.md')
    expect(data).not.toContain('a.ts')
  }
})

test('无匹配返回友好提示', async () => {
  const result = await GlobTool.execute({ pattern: '**/*.nonexistent' }, ctx)
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.data as string).toMatch(/无匹配|no match/i)
  }
})

test('isReadOnly 和 isConcurrencySafe 都是 true', () => {
  expect(GlobTool.isReadOnly?.()).toBe(true)
  expect(GlobTool.isConcurrencySafe?.()).toBe(true)
})
