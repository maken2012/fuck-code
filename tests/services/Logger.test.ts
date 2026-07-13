// tests/services/Logger.test.ts
import { test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { Effect } from 'effect'
import { Logger, LoggerLive } from '@/services/Logger.js'

// 通过 spy 捕获 process.stderr.write，断言真实输出内容（而不是仅"不抛错"）。
// 注意：写入函数返回 true（process.stderr.write 在 Node/Bun 下返回 boolean）。
let stderrSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  stderrSpy = spyOn(process.stderr, 'write').mockReturnValue(true)
})

afterEach(() => {
  stderrSpy.mockRestore()
})

function output(): string {
  // 多次 write 调用合并为一个字符串。
  // write 的第一参数类型为 string | Uint8Array，统一转成 string 再 join。
  return stderrSpy.mock.calls.map((c: [chunk: unknown]) => String(c[0])).join('')
}

test('info 写入 stderr 并包含 level / meta', async () => {
  const program = Effect.gen(function* () {
    const logger = yield* Logger
    logger.info('hello', { k: 'v' })
  })
  await Effect.runPromise(program.pipe(Effect.provide(LoggerLive({ verbose: false }))))

  const out = output()
  expect(out).toContain('[INFO]')
  expect(out).toContain('hello')
  expect(out).toContain('"k":"v"')  // meta 被序列化（JSON 内无空格）
  expect(out).toMatch(/\n$/)        // 以换行结尾
  expect(out).toMatch(/^\[\d{4}-\d{2}-\d{2}T/)  // 以 ISO 时间戳开头
})

test('verbose=false 时 debug 不写 stderr', async () => {
  const program = Effect.gen(function* () {
    const logger = yield* Logger
    logger.debug('hidden')
    logger.info('visible')  // 对照：info 仍写
  })
  await Effect.runPromise(program.pipe(Effect.provide(LoggerLive({ verbose: false }))))

  const out = output()
  expect(out).not.toContain('hidden')
  expect(out).not.toContain('[DEBUG]')
  expect(out).toContain('visible')
  expect(out).toContain('[INFO]')
})

test('verbose=true 时 debug 也写 stderr', async () => {
  const program = Effect.gen(function* () {
    const logger = yield* Logger
    logger.debug('visible-now')
  })
  await Effect.runPromise(program.pipe(Effect.provide(LoggerLive({ verbose: true }))))

  const out = output()
  expect(out).toContain('[DEBUG]')
  expect(out).toContain('visible-now')
})

test('warn / error 级别同样写入', async () => {
  const program = Effect.gen(function* () {
    const logger = yield* Logger
    logger.warn('careful')
    logger.error('broken')
  })
  await Effect.runPromise(program.pipe(Effect.provide(LoggerLive({ verbose: false }))))

  const out = output()
  expect(out).toContain('[WARN]')
  expect(out).toContain('careful')
  expect(out).toContain('[ERROR]')
  expect(out).toContain('broken')
})

test('空 meta 不追加 JSON 片段', async () => {
  const program = Effect.gen(function* () {
    const logger = yield* Logger
    logger.info('no-meta-here')
  })
  await Effect.runPromise(program.pipe(Effect.provide(LoggerLive({ verbose: false }))))

  const out = output()
  // msg 后紧跟换行（没有多余 JSON）
  expect(out).toContain('[INFO] no-meta-here\n')
  expect(out).not.toContain('{}')
})

test('默认 verbose=false（省略 opts）', async () => {
  const program = Effect.gen(function* () {
    const logger = yield* Logger
    logger.debug('should-be-hidden')
  })
  await Effect.runPromise(program.pipe(Effect.provide(LoggerLive())))

  expect(output()).toBe('')
})
