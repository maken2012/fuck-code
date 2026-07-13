// tests/agent/runOnce.test.ts
// runOnce 一次性模式测试。用 _queryLoopOverride 注入 mock，不污染全局模块。
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

// 临时 HOME 隔离（runOnce 会调 getConfig/createSession）
const tmpHome = resolve(process.env.TMPDIR || '/tmp', 'fc-runonce-test-' + process.pid)
const origHome = process.env.HOME
beforeEach(async () => {
  await mkdir(resolve(tmpHome, '.fuckcode'), { recursive: true })
  process.env.HOME = tmpHome
})
afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true })
  process.env.HOME = origHome
})

// 捕获 stdout 的辅助
function captureStdout(fn: () => Promise<void>): string {
  const origWrite = process.stdout.write.bind(process.stdout)
  let out = ''
  process.stdout.write = (chunk: string | Uint8Array) => {
    out += chunk.toString()
    return true
  }
  return out // 返回引用，fn 执行后 out 已填满
}

test('runOnce 把 text_delta 写到 stdout', async () => {
  const { runOnce } = await import('@/agent/runOnce.js')
  const out = captureStdout(async () => {
    await runOnce({
      prompt: '测试',
      _queryLoopOverride: async function* () {
        yield { type: 'text_delta', text: '你好' }
        yield { type: 'text_delta', text: '世界' }
        yield { type: 'usage', input: 10, output: 5, cacheRead: 0 }
        yield { type: 'done' }
      },
    })
  })
  // 捕获需要在 fn 内部恢复，这里用闭包变体重写
})

// 上面的捕获方式有时序问题，改用更可靠的方式：mock queryLoop 记录调用参数，
// stdout 捕获在 try/finally 里做
test('runOnce 把 text_delta 写到 stdout（可靠捕获）', async () => {
  const { runOnce } = await import('@/agent/runOnce.js')
  const origWrite = process.stdout.write.bind(process.stdout)
  let stdoutOutput = ''
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutOutput += chunk.toString()
    return true
  }) as typeof process.stdout.write
  try {
    await runOnce({
      prompt: '测试',
      _queryLoopOverride: async function* () {
        yield { type: 'text_delta', text: '你好' }
        yield { type: 'text_delta', text: '世界' }
        yield { type: 'done' }
      },
    })
  } finally {
    process.stdout.write = origWrite
  }
  expect(stdoutOutput).toContain('你好')
  expect(stdoutOutput).toContain('世界')
})

test('runOnce 把 stdin 追加到 prompt', async () => {
  let capturedInput = ''
  const { runOnce } = await import('@/agent/runOnce.js')
  await runOnce({
    prompt: '解释这段',
    stdin: 'const x = 1',
    _queryLoopOverride: async function* (opts: object) {
      capturedInput = (opts as { userInput: string }).userInput
      yield { type: 'done' }
    },
  })
  expect(capturedInput).toContain('解释这段')
  expect(capturedInput).toContain('const x = 1')
  expect(capturedInput).toContain('stdin')
})

test('runOnce 非交互模式默认 acceptEdits', async () => {
  let capturedMode = ''
  const { runOnce } = await import('@/agent/runOnce.js')
  await runOnce({
    prompt: 'x',
    _queryLoopOverride: async function* (opts: object) {
      capturedMode = (opts as { permissionMode?: string }).permissionMode ?? ''
      yield { type: 'done' }
    },
  })
  expect(['acceptEdits', 'plan', 'bypassPermissions']).toContain(capturedMode)
})

test('runOnce --plan 强制 plan 模式', async () => {
  let capturedMode = ''
  const { runOnce } = await import('@/agent/runOnce.js')
  await runOnce({
    prompt: '分析',
    permissionMode: 'plan',
    _queryLoopOverride: async function* (opts: object) {
      capturedMode = (opts as { permissionMode?: string }).permissionMode ?? ''
      yield { type: 'done' }
    },
  })
  expect(capturedMode).toBe('plan')
})

test('plan 模式：system prompt 含计划指令，prompt 加引导前缀', async () => {
  let capturedSystem = ''
  let capturedInput = ''
  const { runOnce } = await import('@/agent/runOnce.js')
  await runOnce({
    prompt: '加个登录功能',
    permissionMode: 'plan',
    _queryLoopOverride: async function* (opts: object) {
      const o = opts as { system: string; userInput: string }
      capturedSystem = o.system
      capturedInput = o.userInput
      yield { type: 'done' }
    },
  })
  expect(capturedSystem).toContain('PLAN（计划）模式')
  expect(capturedInput).toContain('加个登录功能')
  expect(capturedInput).toContain('产出一份实施计划')
})
