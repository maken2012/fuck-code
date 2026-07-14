// tests/tools/Grep.test.ts
// Grep 工具测试（ripgrep）：基本搜索 / glob 过滤 / ignore_case / 无匹配 / 只读标记
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { GrepTool } from '@/tools/Grep.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-grep-test-' + process.pid)
const ctx = {
  cwd: tmpDir,
  abortSignal: new AbortController().signal,
  readFileState: new Map<string, { mtime: number; readAt: number }>(),
}

beforeEach(async () => {
  await mkdir(tmpDir, { recursive: true })
  await writeFile(resolve(tmpDir, 'a.ts'), 'const hello = "world"\nconst foo = 1\n')
  await writeFile(resolve(tmpDir, 'b.ts'), 'export const hello = () => 2\n')
  await writeFile(resolve(tmpDir, 'c.md'), '# Hello Header\n')
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

test('搜索到匹配行（带文件名 + 行号）', async () => {
  const result = await GrepTool.execute({ pattern: 'hello', output_mode: 'content' }, ctx)
  expect(result.ok).toBe(true)
  if (result.ok) {
    const data = result.data as string
    expect(data).toMatch(/a\.ts/)
    expect(data).toMatch(/b\.ts/)
    expect(data).toMatch(/hello/)
  }
})

test('无匹配返回友好提示', async () => {
  const result = await GrepTool.execute({ pattern: 'zzz_not_exist' }, ctx)
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.data as string).toMatch(/无匹配|no match/i)
  }
})

test('glob 过滤只搜指定类型', async () => {
  const result = await GrepTool.execute({ pattern: 'hello', glob: '*.ts' }, ctx)
  expect(result.ok).toBe(true)
  if (result.ok) {
    const data = result.data as string
    expect(data).toMatch(/a\.ts|b\.ts/)
    expect(data).not.toMatch(/c\.md/) // 被 glob 排除
  }
})

test('ignore_case 忽略大小写', async () => {
  const sensitive = await GrepTool.execute({ pattern: 'hello', glob: '*.md', output_mode: 'content' }, ctx)
  const insensitive = await GrepTool.execute(
    { pattern: 'hello', glob: '*.md', ignore_case: true, output_mode: 'content' },
    ctx,
  )
  expect(sensitive.ok).toBe(true)
  expect(insensitive.ok).toBe(true)
  if (sensitive.ok && insensitive.ok) {
    expect(sensitive.data as string).toMatch(/无匹配|no match/i)
    expect(insensitive.data as string).toMatch(/Hello/)
  }
})

test('isReadOnly 和 isConcurrencySafe 都是 true', () => {
  expect(GrepTool.isReadOnly?.()).toBe(true)
  expect(GrepTool.isConcurrencySafe?.()).toBe(true)
})
