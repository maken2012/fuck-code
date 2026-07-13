// tests/tools/Edit.test.ts
// Edit 工具测试（核心护栏）：写前必读 / 未读拒绝 / mtime 变化拒绝 /
// old_string 不存在 / 多匹配非 replace_all 报错 / replace_all / 正常替换 / 无残留
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, rm, readFile, readdir, utimes } from 'node:fs/promises'
import { resolve } from 'node:path'
import { EditTool } from '@/tools/Edit.js'
import { ReadTool } from '@/tools/Read.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-edit-test-' + process.pid)

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

// 帮助：读文件并返回 ctx（已记录 readFileState）
async function readFirst(filePath: string, ctx: ReturnType<typeof makeCtx>) {
  await ReadTool.execute({ file_path: filePath }, ctx)
}

test('正常替换：old_string 存在且唯一', async () => {
  const ctx = makeCtx()
  const filePath = resolve(tmpDir, 'a.ts')
  await writeFile(filePath, 'const a = 1\nconst b = 2\n')
  await readFirst(filePath, ctx)

  const result = await EditTool.execute(
    { file_path: filePath, old_string: 'const a = 1', new_string: 'const a = 42' },
    ctx,
  )
  expect(result.ok).toBe(true)
  expect(await readFile(filePath, 'utf8')).toBe('const a = 42\nconst b = 2\n')
})

test('未读直接 Edit：拒绝（hard guard）', async () => {
  const ctx = makeCtx()
  const filePath = resolve(tmpDir, 'unread.ts')
  await writeFile(filePath, 'const x = 1\n')

  const result = await EditTool.execute(
    { file_path: filePath, old_string: 'const x = 1', new_string: 'const x = 2' },
    ctx,
  )
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toMatch(/Read|读/i)
  expect(await readFile(filePath, 'utf8')).toBe('const x = 1\n') // 未改动
})

test('mtime 变化（外部修改）拒绝：文件读完之后被改过', async () => {
  const ctx = makeCtx()
  const filePath = resolve(tmpDir, 'externally-modified.ts')
  await writeFile(filePath, 'line1\n')
  await readFirst(filePath, ctx)
  const stateBefore = ctx.readFileState.get(filePath)!

  // 模拟外部修改：改内容 + 把 mtime 往后推（保证与记录的不一致）
  await writeFile(filePath, 'line1-changed\n')
  const future = new Date(Date.now() / 1000 + 1000)
  await utimes(filePath, future, future)

  const result = await EditTool.execute(
    { file_path: filePath, old_string: 'line1', new_string: 'line1-edited' },
    ctx,
  )
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toMatch(/修改|外部|mtime|modified/i)
  // 状态没变（拒绝时不应更新）
  expect(ctx.readFileState.get(filePath)).toEqual(stateBefore)
})

test('old_string 不存在：拒绝', async () => {
  const ctx = makeCtx()
  const filePath = resolve(tmpDir, 'no-match.ts')
  await writeFile(filePath, 'hello world\n')
  await readFirst(filePath, ctx)

  const result = await EditTool.execute(
    { file_path: filePath, old_string: 'not present', new_string: 'x' },
    ctx,
  )
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toMatch(/不存在|not found|找不到/i)
})

test('多个匹配且非 replace_all：拒绝（唯一性要求）', async () => {
  const ctx = makeCtx()
  const filePath = resolve(tmpDir, 'multi.ts')
  await writeFile(filePath, 'foo\nfoo\nfoo\n')
  await readFirst(filePath, ctx)

  const result = await EditTool.execute(
    { file_path: filePath, old_string: 'foo', new_string: 'bar' },
    ctx,
  )
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toMatch(/多个|unique|唯一|2|3/i)
})

test('replace_all=true：替换所有匹配', async () => {
  const ctx = makeCtx()
  const filePath = resolve(tmpDir, 'all.ts')
  await writeFile(filePath, 'foo\nfoo\nfoo\n')
  await readFirst(filePath, ctx)

  const result = await EditTool.execute(
    { file_path: filePath, old_string: 'foo', new_string: 'bar', replace_all: true },
    ctx,
  )
  expect(result.ok).toBe(true)
  expect(await readFile(filePath, 'utf8')).toBe('bar\nbar\nbar\n')
})

test('替换后 readFileState 更新（mtime 推进）', async () => {
  const ctx = makeCtx()
  const filePath = resolve(tmpDir, 'state.ts')
  await writeFile(filePath, 'a\n')
  await readFirst(filePath, ctx)
  const mtimeBefore = ctx.readFileState.get(filePath)!.mtime

  const result = await EditTool.execute(
    { file_path: filePath, old_string: 'a', new_string: 'b' },
    ctx,
  )
  expect(result.ok).toBe(true)
  const stateAfter = ctx.readFileState.get(filePath)!
  expect(stateAfter.mtime).toBeGreaterThanOrEqual(mtimeBefore)
})

test('原子写：替换后不留 .tmp 残留', async () => {
  const ctx = makeCtx()
  const filePath = resolve(tmpDir, 'atomic.ts')
  await writeFile(filePath, 'old\n')
  await readFirst(filePath, ctx)

  await EditTool.execute(
    { file_path: filePath, old_string: 'old', new_string: 'new' },
    ctx,
  )
  const entries = await readdir(tmpDir)
  expect(entries.filter((n) => n.includes('.tmp.'))).toEqual([])
})

test('isReadOnly=false, isConcurrencySafe=false', () => {
  expect(EditTool.isReadOnly?.()).toBe(false)
  expect(EditTool.isConcurrencySafe?.()).toBe(false)
})
