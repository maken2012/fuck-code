// tests/utils/tokens.test.ts
// token 粗估测试。验证中英文混合加权逻辑。
//
// 预期（spec）：
// - 纯英文 'hello world'（11 字符）：11/4 ≈ 3 token
// - 纯中文 '你好世界'（4 字符）：4/1.5 ≈ 3 token
// - estimateMessagesTokens：遍历 string 与 ContentBlock[] 两种 content
import { test, expect } from 'bun:test'
import {
  estimateTokens,
  estimateMessagesTokens,
} from '@/utils/tokens.js'
import type { ChatMessage } from '@/llm/types.js'

test('纯英文约 4 字符/token', () => {
  // 11 字符 → ~3 token（Math.ceil(11/4)=3）
  expect(estimateTokens('hello world')).toBe(3)
  // 空 → 0
  expect(estimateTokens('')).toBe(0)
})

test('纯中文约 1.5 字符/token', () => {
  // 4 字符 → Math.ceil(4/1.5)=3
  expect(estimateTokens('你好世界')).toBe(3)
  // 6 字符 → Math.ceil(6/1.5)=4
  expect(estimateTokens('你好世界测试')).toBe(4)
})

test('混合文本按比例加权', () => {
  // 'hello 你好' = 6 英文 + 空格(英文) + 2 中文
  // 英文部分 7 字符（含空格）/4 ≈ 1.75，中文 2 字符 /1.5 ≈ 1.33
  // 合计约 3 token（加权后取整）
  const t = estimateTokens('hello 你好')
  expect(t).toBeGreaterThan(0)
  expect(t).toBeLessThan(10) // 粗估合理范围
  // 至少不低于纯中文的 2（ceil(2/1.5)=2）
  expect(t).toBeGreaterThanOrEqual(2)
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
  // 至少应包含三段 text 的估算
  expect(total).toBeGreaterThanOrEqual(4)
})

test('estimateMessagesTokens：空数组返回 0', () => {
  expect(estimateMessagesTokens([])).toBe(0)
})
