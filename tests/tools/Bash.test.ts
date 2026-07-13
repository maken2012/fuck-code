// tests/tools/Bash.test.ts
// Bash 工具测试：echo 命令 / 非零退出码（false）/ 超时（sleep）/ 输出截断 / 后台返回 pid / 只读标记
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BashTool } from '@/tools/Bash.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-bash-test-' + process.pid)

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

test('echo 命令：成功执行，stdout 返回', async () => {
  const result = await BashTool.execute({ command: 'echo hello-world' }, makeCtx())
  expect(result.ok).toBe(true)
  if (result.ok) {
    const data = result.data as { stdout: string; exitCode: number | null }
    expect(data.stdout).toMatch(/hello-world/)
    expect(data.exitCode).toBe(0)
  }
})

test('非零退出码：返回 ok=false（false 命令退出 1）', async () => {
  const result = await BashTool.execute({ command: 'false' }, makeCtx())
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toMatch(/退出|exit|code|1/i)
})

test('超时：sleep 超时被 kill，返回错误', async () => {
  const result = await BashTool.execute(
    { command: 'sleep 5', timeout: 300 },
    makeCtx(),
  )
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toMatch(/超时|timeout|timed out/i)
}, 10000)

test('输出截断：stdout 超 30000 字符被截断', async () => {
  // 生成约 60000 字符输出
  const result = await BashTool.execute(
    { command: 'yes hello | head -c 60000' },
    makeCtx(),
  )
  expect(result.ok).toBe(true)
  if (result.ok) {
    const data = result.data as { stdout?: string; truncated?: boolean }
    // stdout 被截断到 <= 30000，且标记 truncated
    expect(data.stdout!.length).toBeLessThanOrEqual(30000)
    expect(data.truncated).toBe(true)
  }
})

test('run_in_background：立即返回 pid', async () => {
  const result = await BashTool.execute(
    { command: 'sleep 2', run_in_background: true },
    makeCtx(),
  )
  expect(result.ok).toBe(true)
  if (result.ok) {
    const data = result.data as { pid: number; background: boolean }
    expect(data.background).toBe(true)
    expect(typeof data.pid).toBe('number')
    expect(data.pid).toBeGreaterThan(0)
  }
})

test('isReadOnly=false, isConcurrencySafe=false', () => {
  expect(BashTool.isReadOnly?.()).toBe(false)
  expect(BashTool.isConcurrencySafe?.()).toBe(false)
})
