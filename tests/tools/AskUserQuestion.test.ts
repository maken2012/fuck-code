// tests/tools/AskUserQuestion.test.ts
import { test, expect } from 'bun:test'
import { AskUserQuestionTool, takePendingQuestion } from '@/tools/AskUserQuestion.js'

const ctx = { cwd: '/tmp', abortSignal: new AbortController().signal, readFileState: new Map() }

test('元数据', () => {
  expect(AskUserQuestionTool.name).toBe('AskUserQuestion')
  expect(AskUserQuestionTool.isReadOnly?.()).toBe(true)
  expect(AskUserQuestionTool.isConcurrencySafe?.()).toBe(false)
})

test('execute 挂起直到用户回答', async () => {
  const execPromise = AskUserQuestionTool.execute(
    {
      question: '选哪个？',
      header: '方案',
      options: [{ label: 'A' }, { label: 'B' }],
    },
    ctx,
  )
  // 应该有个 pending question
  const q = await takePendingQuestion()
  expect(q).not.toBeNull()
  expect(q?.header).toBe('方案')
  expect(q?.options.length).toBe(2)
  // 回答
  q?.resolve(['A'])
  const result = await execPromise
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.data).toContain('A')
})

test('inputSchema 要求至少 2 个选项', () => {
  const bad = AskUserQuestionTool.inputSchema.safeParse({
    question: 'q', header: 'h', options: [{ label: 'only one' }],
  })
  expect(bad.success).toBe(false)
})
