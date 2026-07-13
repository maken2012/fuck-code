// tests/llm/provider.test.ts
// Provider 抽象 + OpenAI 兼容测试。用 _clientOverride mock，不真实调 API。
import { test, expect } from 'bun:test'
import { detectProvider, streamMessage } from '@/llm/provider.js'

test('detectProvider：claude 模型 → anthropic', () => {
  expect(detectProvider('claude-sonnet-4-5-20250929')).toBe('anthropic')
  expect(detectProvider('claude-opus-4-1')).toBe('anthropic')
})

test('detectProvider：gpt/o1/o3 → openai', () => {
  expect(detectProvider('gpt-4o')).toBe('openai')
  expect(detectProvider('o1-preview')).toBe('openai')
  expect(detectProvider('o3-mini')).toBe('openai')
})

test('detectProvider：未知模型 + baseURL → openai-compatible', () => {
  expect(detectProvider('deepseek-chat', 'https://api.deepseek.com')).toBe('openai-compatible')
  expect(detectProvider('llama3', 'http://localhost:11434/v1')).toBe('openai-compatible')
})

test('detectProvider：未知模型 + anthropic baseURL → anthropic', () => {
  expect(detectProvider('custom-model', 'https://api.anthropic.com')).toBe('anthropic')
})

test('detectProvider：explicit 覆盖自动判定', () => {
  expect(detectProvider('claude-sonnet', undefined, 'openai')).toBe('openai')
  expect(detectProvider('gpt-4', undefined, 'anthropic')).toBe('anthropic')
})

// mock OpenAI 兼容 stream
function fakeOpenAIStream(events: object[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
    },
  }
}

test('streamMessage：OpenAI 兼容 provider 解析文本流', async () => {
  const events: object[] = [
    { choices: [{ delta: { content: '你好' } }] },
    { choices: [{ delta: { content: '世界' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ]
  const out: { type: string; textDelta?: string }[] = []
  for await (const e of streamMessage({
    model: 'deepseek-chat',
    system: 'test',
    messages: [{ role: 'user', content: 'hi' }],
    signal: new AbortController().signal,
    apiBaseUrl: 'https://api.deepseek.com',
    _clientOverride: {
      chat: { completions: { create: async () => fakeOpenAIStream(events) } },
    },
  })) {
    out.push(e as { type: string; textDelta?: string })
  }
  const texts = out.filter((e) => e.type === 'text')
  expect(texts.length).toBe(2)
  expect(texts[0]?.textDelta).toBe('你好')
  const usage = out.find((e) => e.type === 'usage') as { input: number; output: number } | undefined
  expect(usage?.input).toBe(10)
  expect(usage?.output).toBe(5)
})

test('streamMessage：Anthropic 模型仍走 anthropic provider', async () => {
  // 用 anthropic 的 _clientOverride 验证路由正确
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'claude回复' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]
  const out: string[] = []
  for await (const e of streamMessage({
    model: 'claude-sonnet-4-5',
    system: 's',
    messages: [],
    signal: new AbortController().signal,
    _clientOverride: { messages: { create: async () => fakeOpenAIStream(events) } },
  })) {
    if ((e as { type: string }).type === 'text') out.push((e as { textDelta: string }).textDelta)
  }
  expect(out).toEqual(['claude回复'])
})
