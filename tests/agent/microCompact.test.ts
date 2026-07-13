// tests/agent/microCompact.test.ts
import { test, expect } from 'bun:test'
import { microCompactMessages, getCompactableTools } from '@/agent/microCompact.js'
import type { ChatMessage } from '@/llm/types.js'

function makeMessages(toolResults: { toolName: string; toolUseId: string; content: string }[]): ChatMessage[] {
  const content: ContentBlock[] = []
  // 先放所有 tool_use
  for (const tr of toolResults) {
    content.push({ type: 'tool_use', id: tr.toolUseId, name: tr.toolName, input: {} })
  }
  // 再放对应 tool_result
  for (const tr of toolResults) {
    content.push({ type: 'tool_result', tool_use_id: tr.toolUseId, content: tr.content })
  }
  return [{ role: 'user', content }]
}

type ContentBlock = import('@/llm/types.js').ContentBlock

test('getCompactableTools 含 Read/Bash/Grep', () => {
  const tools = getCompactableTools()
  expect(tools).toContain('Read')
  expect(tools).toContain('Bash')
  expect(tools).toContain('Grep')
})

test('少于 KEEP_RECENT 不压缩', () => {
  const msgs = makeMessages([
    { toolName: 'Read', toolUseId: 't1', content: 'x'.repeat(1000) },
    { toolName: 'Read', toolUseId: 't2', content: 'x'.repeat(1000) },
  ])
  const count = microCompactMessages(msgs)
  expect(count).toBe(0) // 只有 2 个，KEEP_RECENT=4，不压缩
})

test('压缩旧的大结果，保留最近 4 个', () => {
  const msgs = makeMessages([
    { toolName: 'Read', toolUseId: 't1', content: 'x'.repeat(1000) },
    { toolName: 'Read', toolUseId: 't2', content: 'x'.repeat(1000) },
    { toolName: 'Read', toolUseId: 't3', content: 'x'.repeat(1000) },
    { toolName: 'Read', toolUseId: 't4', content: 'x'.repeat(1000) },
    { toolName: 'Read', toolUseId: 't5', content: 'x'.repeat(1000) },
    { toolName: 'Read', toolUseId: 't6', content: 'x'.repeat(1000) },
    { toolName: 'Read', toolUseId: 't7', content: 'x'.repeat(1000) },
  ])
  const count = microCompactMessages(msgs)
  expect(count).toBe(3) // 7 个 - 4 保留 = 3 个被压缩
})

test('不压缩小结果（< 500 字符）', () => {
  const msgs = makeMessages([
    { toolName: 'Read', toolUseId: 't1', content: 'small' }, // < 500
    { toolName: 'Read', toolUseId: 't2', content: 'small' },
    { toolName: 'Read', toolUseId: 't3', content: 'small' },
    { toolName: 'Read', toolUseId: 't4', content: 'small' },
    { toolName: 'Read', toolUseId: 't5', content: 'small' },
    { toolName: 'Read', toolUseId: 't6', content: 'small' },
  ])
  const count = microCompactMessages(msgs)
  expect(count).toBe(0) // 都 < 500，不压缩
})

test('只压缩可压缩工具（非 Edit/Write 的结果）', () => {
  // Edit 的结果不在 COMPACTABLE_TOOLS，不应压缩
  const msgs = makeMessages([
    { toolName: 'Edit', toolUseId: 'e1', content: 'x'.repeat(1000) },
    { toolName: 'Edit', toolUseId: 'e2', content: 'x'.repeat(1000) },
    { toolName: 'Edit', toolUseId: 'e3', content: 'x'.repeat(1000) },
    { toolName: 'Edit', toolUseId: 'e4', content: 'x'.repeat(1000) },
    { toolName: 'Edit', toolUseId: 'e5', content: 'x'.repeat(1000) },
  ])
  const count = microCompactMessages(msgs)
  expect(count).toBe(0) // Edit 不可压缩
})

test('压缩后的内容是占位符', () => {
  const msgs = makeMessages([
    { toolName: 'Bash', toolUseId: 'b1', content: 'x'.repeat(1000) },
    { toolName: 'Bash', toolUseId: 'b2', content: 'x'.repeat(1000) },
    { toolName: 'Bash', toolUseId: 'b3', content: 'x'.repeat(1000) },
    { toolName: 'Bash', toolUseId: 'b4', content: 'x'.repeat(1000) },
    { toolName: 'Bash', toolUseId: 'b5', content: 'x'.repeat(1000) },
    { toolName: 'Bash', toolUseId: 'b6', content: 'x'.repeat(1000) },
  ])
  microCompactMessages(msgs)
  // 检查最早的那个是否被替换成占位符
  const userMsg = msgs[0]
  if (userMsg && typeof userMsg.content !== 'string') {
    const b1Result = userMsg.content.find((b) => b.type === 'tool_result' && b.tool_use_id === 'b1')
    expect(b1Result && b1Result.type === 'tool_result' && b1Result.content).toBe('[Old tool result content cleared]')
  }
})
