// tests/utils/diff.test.ts
import { test, expect } from 'bun:test'
import { diffText, formatDiff } from '@/utils/diff.js'

test('diffText：相同文本无变更', () => {
  const d = diffText('a\nb\nc', 'a\nb\nc')
  expect(d.every((l) => l.type === 'ctx')).toBe(true)
})

test('diffText：纯新增', () => {
  const d = diffText('', 'new line')
  expect(d.some((l) => l.type === 'add' && l.text === 'new line')).toBe(true)
})

test('diffText：纯删除', () => {
  const d = diffText('old line', '')
  expect(d.some((l) => l.type === 'del' && l.text === 'old line')).toBe(true)
})

test('diffText：修改', () => {
  const d = diffText('a\nold\nc', 'a\nnew\nc')
  const adds = d.filter((l) => l.type === 'add')
  const dels = d.filter((l) => l.type === 'del')
  expect(adds.some((l) => l.text === 'new')).toBe(true)
  expect(dels.some((l) => l.text === 'old')).toBe(true)
})

test('formatDiff：含 ANSI 颜色码', () => {
  const d = diffText('a', 'b')
  const formatted = formatDiff(d)
  expect(formatted).toContain('\x1b[32m') // 绿色（add）
  expect(formatted).toContain('\x1b[31m') // 红色（del）
})

test('formatDiff：只显示变更周围上下文', () => {
  const oldText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
  const newText = oldText.replace('line 10', 'CHANGED')
  const d = diffText(oldText, newText)
  const formatted = formatDiff(d, 2)
  // 应该只含 line 8-12 左右，不含 line 0/19
  expect(formatted).toContain('CHANGED')
  expect(formatted).not.toContain('line 0')
  expect(formatted).not.toContain('line 19')
})
