// tests/agent/queryLoop.test.ts
// mock streamAnthropic via _llmOverride，验证 queryLoop 的事件转发 / abort 逻辑。
import { test, expect, mock, beforeEach } from 'bun:test'
import type { LlmEvent } from '@/llm/types.js'

// 用动态 import 加载被测模块（顶层 await）
const { queryLoop } = await import('@/agent/queryLoop.js')

// _llmOverride 的签名：与 queryLoop 内 _llmOverride 一致（接收 opts: object，返回 LlmEvent 异步生成器）
// 用 object 是为了让 mock 不必精确刻画 LLM 子选项，且与生产 streamAnthropic 调用点兼容。
type LlmStreamFn = (opts: object) => AsyncGenerator<LlmEvent>

// mock 的 streamAnthropic —— 默认空生成器，每个 test 用 mockImplementation 覆盖
const mockStream = mock<LlmStreamFn>(async function* () {
  /* empty */
})

// 构造假 streamAnthropic 返回的事件序列
async function* fakeLlmEvents(events: LlmEvent[]): AsyncGenerator<LlmEvent> {
  for (const e of events) yield e
}

beforeEach(() => mockStream.mockClear())

test('单轮对话：转发 text_delta + usage + turn_end + done', async () => {
  mockStream.mockImplementation(() =>
    fakeLlmEvents([
      { type: 'text', textDelta: '你好' },
      { type: 'text', textDelta: '！' },
      { type: 'usage', input: 10, output: 5, cacheRead: 0 },
      { type: 'done', stopReason: 'end_turn' },
    ]),
  )

  const out = []
  for await (const e of queryLoop({
    history: [],
    userInput: 'hi',
    model: 'm',
    system: 's',
    signal: new AbortController().signal,
    _llmOverride: mockStream,
  })) {
    out.push(e)
  }

  // 应有：2 个 text_delta + 1 usage + 1 turn_end + 1 done（无工具所以一轮就 done）
  expect(out.filter((e) => e.type === 'text_delta').length).toBe(2)
  expect(out.find((e) => e.type === 'turn_end')).toBeDefined()
  expect(out.find((e) => e.type === 'usage')).toBeDefined()
  expect(out.find((e) => e.type === 'done')).toBeDefined()
})

test('stop_reason 非 end_turn（如 max_tokens）也正常结束', async () => {
  mockStream.mockImplementation(() =>
    fakeLlmEvents([
      { type: 'text', textDelta: '截断' },
      { type: 'usage', input: 5, output: 100, cacheRead: 0 },
      { type: 'done', stopReason: 'max_tokens' },
    ]),
  )
  const out = []
  for await (const e of queryLoop({
    history: [],
    userInput: 'x',
    model: 'm',
    system: 's',
    signal: new AbortController().signal,
    _llmOverride: mockStream,
  })) {
    out.push(e)
  }
  const turnEnd = out.find((e) => e.type === 'turn_end')
  if (turnEnd && turnEnd.type === 'turn_end') {
    expect(turnEnd.stopReason).toBe('max_tokens')
  } else {
    throw new Error('missing turn_end')
  }
})

test('abort 时 yield aborted + done', async () => {
  const ac = new AbortController()
  // mock 的 stream 直接抛 AbortError（模拟 streamAnthropic abort 行为）
  mockStream.mockImplementation(() => {
    throw new DOMException('Aborted', 'AbortError')
  })
  ac.abort()
  const out = []
  for await (const e of queryLoop({
    history: [],
    userInput: 'x',
    model: 'm',
    system: 's',
    signal: ac.signal,
    _llmOverride: mockStream,
  })) {
    out.push(e)
  }
  expect(out.find((e) => e.type === 'aborted')).toBeDefined()
  expect(out.find((e) => e.type === 'done')).toBeDefined()
})
