// tests/agent/compact.test.ts
// autoCompact 摘要生成测试。mock _llmOverride（与 queryLoop.test 同模式），
// 验证 compactConversation 调 LLM 累积文本返回摘要 + getCompactThreshold 阈值。
import { test, expect, mock, beforeEach } from 'bun:test'
import type { LlmEvent } from '@/llm/types.js'

const { getCompactThreshold, compactConversation } = await import(
  '@/agent/compact.js'
)

type LlmStreamFn = (opts: object) => AsyncGenerator<LlmEvent>

// mock streamFn：默认空生成器，每个 test 用 mockImplementation 覆盖
const mockStream = mock<LlmStreamFn>(async function* () {
  /* empty */
})

beforeEach(() => mockStream.mockClear())

async function* fakeLlmEvents(events: LlmEvent[]): AsyncGenerator<LlmEvent> {
  for (const e of events) yield e
}

test('getCompactThreshold 返回 contextWindow - 13000', () => {
  // 默认 200000 → 187000
  expect(getCompactThreshold(200000)).toBe(187000)
  expect(getCompactThreshold(100000)).toBe(87000)
})

test('compactConversation 调 LLM 累积文本返回摘要', async () => {
  // mock 返回两段文本 + done
  mockStream.mockImplementation(() =>
    fakeLlmEvents([
      { type: 'text', textDelta: '关键决策：' },
      { type: 'text', textDelta: '采用了 Effect.ts' },
      { type: 'usage', input: 10, output: 5, cacheRead: 0 },
      { type: 'done', stopReason: 'end_turn' },
    ]),
  )

  const summary = await compactConversation(
    [{ role: 'user', content: '历史对话' }],
    { model: 'm', signal: new AbortController().signal, _llmOverride: mockStream },
  )

  expect(summary).toBe('关键决策：采用了 Effect.ts')
  // 应被调用一次
  expect(mockStream).toHaveBeenCalledTimes(1)
})

test('compactConversation 空消息列表仍能调 LLM（边界情况）', async () => {
  mockStream.mockImplementation(() =>
    fakeLlmEvents([
      { type: 'text', textDelta: '（无历史）' },
      { type: 'done', stopReason: 'end_turn' },
    ]),
  )

  const summary = await compactConversation([], {
    model: 'm',
    signal: new AbortController().signal,
    _llmOverride: mockStream,
  })
  expect(summary).toBe('（无历史）')
  expect(mockStream).toHaveBeenCalledTimes(1)
})
