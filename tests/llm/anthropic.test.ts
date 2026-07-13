// tests/llm/anthropic.test.ts
import { test, expect, mock, beforeEach } from 'bun:test'
import type { LlmEvent } from '@/llm/types.js'

// 用动态 import 加载被测模块（顶层 await）。_clientOverride 注入 mock client，
// 不真实调 Anthropic API。
const { streamAnthropic } = await import('@/llm/anthropic.js')
import type { MockClient, RawStreamEvent, StreamAnthropicOpts } from '@/llm/anthropic.js'

// 一个会抛 AbortError 的 sentinel（模拟真实 SDK 在中断时的行为）
class AbortError extends DOMException {
  constructor() {
    super('Aborted', 'AbortError')
  }
}

// mock 的 messages.create —— 默认空实现，每个 test 用 mockReturnValue 覆盖
// 签名与 MockClient.messages.create 对齐（返回 async iterable，非 thenable）
const mockCreate = mock<
  (body: object, opts?: object) => AsyncIterable<RawStreamEvent>
>(() => {
  // 返回空流，每个 test 会用 mockReturnValue 覆盖
  return {
    async *[Symbol.asyncIterator]() {
      /* empty */
    },
  }
})
beforeEach(() => mockCreate.mockClear())

// 把 mock 包成 MockClient（结构等价）
function mockClient(): MockClient {
  return { messages: { create: mockCreate } }
}

// 构造一个假的 async iterable，模拟 SDK 的 stream
function fakeStream(events: RawStreamEvent[]): AsyncIterable<RawStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
    },
  }
}

// 构造一个会抛 AbortError 的 stream
function abortingStream(): AsyncIterable<RawStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      throw new AbortError()
    },
  }
}

test('解析纯文本流式响应', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '不该出现' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '世界' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ]
  mockCreate.mockReturnValue(fakeStream(events))

  const out: LlmEvent[] = []
  const opts: StreamAnthropicOpts = {
    model: 'claude-sonnet-4-5-20250929',
    system: 'test',
    messages: [{ role: 'user', content: 'hi' }],
    signal: new AbortController().signal,
    _clientOverride: mockClient(),
  }
  for await (const e of streamAnthropic(opts)) {
    out.push(e)
  }

  // 应有两个 text 事件 + 一个 usage + 一个 done
  const texts = out.filter((e) => e.type === 'text')
  expect(texts.length).toBe(2)
  if (texts[0]?.type === 'text') expect(texts[0].textDelta).toBe('你好')
  if (texts[1]?.type === 'text') expect(texts[1].textDelta).toBe('世界')

  const usage = out.find((e) => e.type === 'usage')
  if (usage && usage.type === 'usage') {
    expect(usage.input).toBe(10)
    expect(usage.cacheRead).toBe(5)
    expect(usage.output).toBe(20) // 来自 message_delta
  } else {
    throw new Error('missing usage event')
  }

  const done = out.find((e) => e.type === 'done')
  if (done && done.type === 'done') {
    expect(done.stopReason).toBe('end_turn')
  } else {
    throw new Error('missing done event')
  }
})

test('content_block_start 的 text 不重复输出', async () => {
  // SDK 会在 content_block_start 发一遍 text，然后 delta 又发——我们应只输出 delta 的
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '完整文本' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完整文本' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  mockCreate.mockReturnValue(fakeStream(events))

  const texts: string[] = []
  for await (const e of streamAnthropic({
    model: 'm',
    system: 's',
    messages: [],
    signal: new AbortController().signal,
    _clientOverride: mockClient(),
  })) {
    if (e.type === 'text') texts.push(e.textDelta)
  }
  expect(texts).toEqual(['完整文本']) // 只一次，不是两次
})

test('abort 时抛 AbortError', async () => {
  const ac = new AbortController()
  // mock 的 stream 在迭代时抛 AbortError（模拟真实 SDK 中断）
  mockCreate.mockReturnValue(abortingStream())
  // 立即 abort
  ac.abort()
  const drain = async () => {
    for await (const _ of streamAnthropic({
      model: 'm',
      system: 's',
      messages: [],
      signal: ac.signal,
      _clientOverride: mockClient(),
    })) {
      // drain
    }
  }
  await expect(drain()).rejects.toThrow(/abort/i)
})
