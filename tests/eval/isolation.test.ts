// tests/eval/isolation.test.ts
// 工作区隔离测试：scratch / from-snapshot 模式 + runCommand + 文件辅助函数。
// from-repo 需要网络，跳过（CI 里单测）。
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { WorkspaceManager, runCommand, readFileRaw, fileExists } from '@/eval/isolation.js'

let mgr: WorkspaceManager
const tmpBase = resolve(process.env.TMPDIR || '/tmp', `fc-eval-iso-test-${process.pid}-${Date.now()}`)

beforeEach(async () => {
  mgr = new WorkspaceManager()
  await mkdir(tmpBase, { recursive: true })
})

afterEach(async () => {
  await mgr.cleanupAll()
  await rm(tmpBase, { recursive: true, force: true })
})

test('scratch 模式：创建文件', async () => {
  const dir = await mgr.create(
    {
      type: 'scratch',
      files: {
        'main.ts': 'console.log(1)',
        'src/util.ts': 'export const x = 1',
        'test/main.test.ts': 'test("t", () => {})',
      },
    },
    'test-scratch',
  )

  expect(await fileExists(join(dir, 'main.ts'))).toBe(true)
  expect(await fileExists(join(dir, 'src/util.ts'))).toBe(true)
  expect(await fileExists(join(dir, 'test/main.test.ts'))).toBe(true)
  expect(await readFileRaw(join(dir, 'main.ts'))).toBe('console.log(1)')
})

test('scratch 模式：子目录自动创建', async () => {
  const dir = await mgr.create(
    {
      type: 'scratch',
      files: { 'a/b/c/d.ts': 'export const deep = true' },
    },
    'test-deep',
  )
  expect(await fileExists(join(dir, 'a/b/c/d.ts'))).toBe(true)
})

test('scratch 模式：空 files 映射', async () => {
  const dir = await mgr.create(
    { type: 'scratch', files: {} },
    'test-empty',
  )
  expect(await fileExists(dir)).toBe(true)
})

test('from-snapshot 模式：复制目录', async () => {
  // 准备快照源
  const snapshot = join(tmpBase, 'snapshot')
  await mkdir(join(snapshot, 'sub'), { recursive: true })
  await writeFile(join(snapshot, 'file.ts'), 'export const a = 1')
  await writeFile(join(snapshot, 'sub/nested.ts'), 'export const b = 2')

  const dir = await mgr.create(
    { type: 'from-snapshot', snapshotDir: snapshot },
    'test-snapshot',
  )

  expect(await fileExists(join(dir, 'file.ts'))).toBe(true)
  expect(await fileExists(join(dir, 'sub/nested.ts'))).toBe(true)
  expect(await readFileRaw(join(dir, 'file.ts'))).toBe('export const a = 1')
})

test('cleanup 删除工作区', async () => {
  const dir = await mgr.create(
    { type: 'scratch', files: { 'x.ts': '1' } },
    'test-cleanup',
  )
  expect(await fileExists(dir)).toBe(true)
  await mgr.cleanup(dir)
  expect(await fileExists(dir)).toBe(false)
})

test('cleanupAll 删除所有工作区', async () => {
  const dir1 = await mgr.create({ type: 'scratch', files: {} }, 't1')
  const dir2 = await mgr.create({ type: 'scratch', files: {} }, 't2')
  await mgr.cleanupAll()
  expect(await fileExists(dir1)).toBe(false)
  expect(await fileExists(dir2)).toBe(false)
})

test('runCommand：成功命令 exit 0', async () => {
  const dir = await mgr.create({ type: 'scratch', files: {} }, 'cmd-ok')
  const result = await runCommand('echo hello', dir, 5000)
  expect(result.ok).toBe(true)
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toBe('hello')
})

test('runCommand：失败命令 exit 非 0', async () => {
  const dir = await mgr.create({ type: 'scratch', files: {} }, 'cmd-fail')
  const result = await runCommand('exit 42', dir, 5000)
  expect(result.ok).toBe(false)
  expect(result.exitCode).toBe(42)
})

test('runCommand：超时返回 timedOut', async () => {
  const dir = await mgr.create({ type: 'scratch', files: {} }, 'cmd-timeout')
  // sleep 5 秒，超时设 1 秒
  const result = await runCommand('sleep 5', dir, 1000)
  expect(result.timedOut).toBe(true)
  expect(result.ok).toBe(false)
})

test('runCommand：stderr 正确捕获', async () => {
  const dir = await mgr.create({ type: 'scratch', files: {} }, 'cmd-stderr')
  const result = await runCommand('echo err >&2', dir, 5000)
  expect(result.ok).toBe(true) // echo 成功
  expect(result.stderr.trim()).toBe('err')
})

test('runCommand：在指定 cwd 执行', async () => {
  const dir = await mgr.create({ type: 'scratch', files: {} }, 'cmd-cwd')
  const result = await runCommand('pwd', dir, 5000)
  expect(result.ok).toBe(true)
  // macOS 的 /var → /private/var 等 symlink，用 realpath 规范化后比对
  const { realpath } = await import('node:fs/promises')
  const [expected, actual] = await Promise.all([
    realpath(dir),
    realpath(result.stdout.trim()),
  ])
  expect(actual).toBe(expected)
})

test('fileExists：不存在的文件返回 false', async () => {
  expect(await fileExists(join(tmpBase, 'nope.ts'))).toBe(false)
})

test('readFileRaw：读取内容', async () => {
  const f = join(tmpBase, 'raw.txt')
  await writeFile(f, 'raw content')
  expect(await readFileRaw(f)).toBe('raw content')
})

test('taskId 净化：特殊字符被替换', async () => {
  const dir = await mgr.create(
    { type: 'scratch', files: {} },
    'task/with-special.chars&id',
  )
  expect(await fileExists(dir)).toBe(true)
  // 目录名里不应有原始的 / 和 &
  expect(dir).not.toContain('/task_with-special.chars_id')
})
