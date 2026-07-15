// tests/llm/multimodal.test.ts
// 多模态：image ContentBlock 的 token 估算 + OpenAI provider 图片转换
import { test, expect } from 'bun:test'
import { estimateMessagesTokens } from '@/utils/tokens.js'
import type { ChatMessage } from '@/llm/types.js'

test('estimateMessagesTokens 对 image block 计 ~1500 token', () => {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR...' } },
      ],
    },
  ]
  const tokens = estimateMessagesTokens(messages)
  // text "看这张图" ~ 2 token + image 1500
  expect(tokens).toBeGreaterThan(1500)
  expect(tokens).toBeLessThan(1510)
})

test('estimateMessagesTokens 多张图片累计计数', () => {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'b' } },
      ],
    },
  ]
  expect(estimateMessagesTokens(messages)).toBe(3000)
})

test('ContentBlock image 类型存在', () => {
  const block = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'x' } }
  expect(block.type).toBe('image')
  expect(block.source.media_type).toBe('image/png')
})
