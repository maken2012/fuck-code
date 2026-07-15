// tests/utils/tokens.test.ts
// token 计数测试。v1.18 改用 gpt-tokenizer（BPE 分词器）精确计数。
//
// 以下值为 gpt-tokenizer 实际输出（GPT BPE），取代旧的字符启发式估算。
// 注：Claude 无公开 tokenizer，gpt-tokenizer 是合理的精确替代。
import { test, expect } from 'bun:test'
import {
  estimateTokens,
  estimateMessagesTokens,
} from '@/utils/tokens.js'
import type { ChatMessage } from '@/llm/types.js'

test('纯英文精确计数', () => {
  // 'hello world' → 2 token（gpt-tokenizer BPE）
  expect(estimateTokens('hello world')).toBe(2)
  // 空 → 0
  expect(estimateTokens('')).toBe(0)
})

test('纯中文精确计数', () => {
  // '你好世界' → 2 token
  expect(estimateTokens('你好世界')).toBe(2)
  // '你好世界测试' → 3 token
  expect(estimateTokens('你好世界测试')).toBe(3)
})

test('混合文本计数', () => {
  // 'hello 你好' → 3 token
  const t = estimateTokens('hello 你好')
  expect(t).toBe(3)
  expect(t).toBeGreaterThan(0)
})

test('estimateMessagesTokens：含 string 和 ContentBlock[] 两种 content', () => {
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'hello' }, // 5 字符 → 2 token
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'world' }, // 5 字符 → 2 token
        {
          type: 'tool_use',
          id: 't1',
          name: 'Read',
          input: { file_path: '/x' },
        }, // tool_use 无 text，不算
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: '你好', // 2 字符 → 2 token
        },
      ],
    },
  ]
  const total = estimateMessagesTokens(msgs)
  expect(total).toBeGreaterThan(0)
  // 三段 text: hello(1) + world(1) + 你好(1) = 3 token（gpt-tokenizer）
  expect(total).toBeGreaterThanOrEqual(3)
})

test('estimateMessagesTokens：空数组返回 0', () => {
  expect(estimateMessagesTokens([])).toBe(0)
})
