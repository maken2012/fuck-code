// tests/eval/driver.test.ts
// EvalDriver 测试：用 _queryLoopOverride 注入 mock，验证事件收集逻辑。
// 不调真实 LLM/session/config。
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { QueryEvent } from '@/agent/types.js'
import type { QueryLoopOpts } from '@/agent/queryLoop.js'
import type { EvalTask } from '@/eval/types.js'
import { EvalDriver } from '@/eval/driver.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', `fc-eval-driver-test-${process.pid}-${Date.now()}`)

beforeEach(async () => {
  await mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

const simpleTask: EvalTask = {
  id: 'test-task',
  name: '测试任务',
  description: '',
  difficulty: 'easy',
  workspace: { type: 'scratch', files: {} },
  turns: [{ prompt: '干活' }],
  judge: { type: 'test', command: 'echo ok' },
}

// 构造假事件序列
async function* fakeEvents(events: QueryEvent[]): AsyncGenerator<QueryEvent> {
  for (const e of events) yield e
}

test('单轮：收集 text_delta + usage + turn_end', async () => {
  const mockQL = (_opts: QueryLoopOpts): AsyncGenerator<QueryEvent> =>
    fakeEvents([
      { type: 'text_delta', text: '你好' },
      { type: 'text_delta', text: '世界' },
      { type: 'usage', input: 10, output: 5, cacheRead: 0 },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'done' },
    ])

  const driver = new EvalDriver()
  const result = await driver.runTask(simpleTask, tmpDir, { llmMode: 'live' }, mockQL)

  expect(result.taskId).toBe('test-task')
  expect(result.turns.length).toBe(1)
  expect(result.turns[0]!.text).toBe('你好世界')
  expect(result.turns[0]!.tokens).toEqual({ input: 10, output: 5 })
  expect(result.turns[0]!.turnCount).toBe(1)
  expect(result.totalTokens).toEqual({ input: 10, output: 5, cacheRead: 0 })
})

test('单轮：收集工具调用', async () => {
  const mockQL = (_opts: QueryLoopOpts): AsyncGenerator<QueryEvent> =>
    fakeEvents([
      { type: 'tool_use_start', tool: 'Read', input: { file_path: '/x' } },
      { type: 'tool_result', tool: 'Read', ok: true, content: 'file content' },
      { type: 'tool_use_start', tool: 'Edit', input: { file_path: '/x' } },
      { type: 'tool_result', tool: 'Edit', ok: true, content: 'edited' },
      { type: 'usage', input: 50, output: 20, cacheRead: 0 },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'done' },
    ])

  const driver = new EvalDriver()
  const result = await driver.runTask(simpleTask, tmpDir, { llmMode: 'live' }, mockQL)

  expect(result.turns[0]!.toolsCalled).toEqual(['Read', 'Edit'])
})

test('单轮：多 turn_end（工具循环多轮）', async () => {
  const mockQL = (_opts: QueryLoopOpts): AsyncGenerator<QueryEvent> =>
    fakeEvents([
      { type: 'tool_use_start', tool: 'Read', input: {} },
      { type: 'turn_end', stopReason: 'tool_use' },
      { type: 'tool_use_start', tool: 'Edit', input: {} },
      { type: 'turn_end', stopReason: 'tool_use' },
      { type: 'text_delta', text: '完成' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', input: 100, output: 50, cacheRead: 0 },
      { type: 'done' },
    ])

  const driver = new EvalDriver()
  const result = await driver.runTask(simpleTask, tmpDir, { llmMode: 'live' }, mockQL)

  expect(result.turns[0]!.turnCount).toBe(3)
})

test('多轮累积：两次 queryLoop 调用', async () => {
  const multiTask: EvalTask = {
    ...simpleTask,
    turns: [{ prompt: '第一步' }, { prompt: '第二步' }],
  }

  let callCount = 0
  const mockQL = (_opts: QueryLoopOpts): AsyncGenerator<QueryEvent> => {
    callCount++
    return fakeEvents([
      { type: 'text_delta', text: `第${callCount}轮回复` },
      { type: 'usage', input: callCount * 10, output: callCount * 5, cacheRead: 0 },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'done' },
    ])
  }

  const driver = new EvalDriver()
  const result = await driver.runTask(multiTask, tmpDir, { llmMode: 'live' }, mockQL)

  expect(result.turns.length).toBe(2)
  expect(result.turns[0]!.text).toBe('第1轮回复')
  expect(result.turns[1]!.text).toBe('第2轮回复')
  expect(result.totalTokens).toEqual({ input: 30, output: 15, cacheRead: 0 })
  expect(callCount).toBe(2)
})

test('permission_request 事件自动 allow', async () => {
  const mockQL = (_opts: QueryLoopOpts): AsyncGenerator<QueryEvent> =>
    fakeEvents([
      { type: 'permission_request', tool: 'Bash', input: {}, inputSummary: 'ls', resolve: () => {} },
      { type: 'text_delta', text: 'ok' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'done' },
    ])

  const driver = new EvalDriver()
  const result = await driver.runTask(simpleTask, tmpDir, { llmMode: 'live' }, mockQL)

  expect(result.turns[0]!.text).toBe('ok')
})

test('error 事件被记录到 text', async () => {
  const mockQL = (_opts: QueryLoopOpts): AsyncGenerator<QueryEvent> =>
    fakeEvents([
      { type: 'error', error: new Error('LLM 炸了'), recoverable: false },
      { type: 'done' },
    ])

  const driver = new EvalDriver()
  const result = await driver.runTask(simpleTask, tmpDir, { llmMode: 'live' }, mockQL)

  expect(result.turns[0]!.text).toContain('LLM 炸了')
})

test('无任何输出时标记 error', async () => {
  const mockQL = (_opts: QueryLoopOpts): AsyncGenerator<QueryEvent> =>
    fakeEvents([
      { type: 'done' },
    ])

  const driver = new EvalDriver()
  const result = await driver.runTask(simpleTask, tmpDir, { llmMode: 'live' }, mockQL)

  expect(result.status).toBe('error')
  expect(result.error).toContain('无任何输出')
})

test('expectTools 被记录到结果', async () => {
  const taskWithExpect: EvalTask = {
    ...simpleTask,
    turns: [{ prompt: 'p', expectTools: ['Edit', 'Bash'] }],
  }

  const mockQL = (_opts: QueryLoopOpts): AsyncGenerator<QueryEvent> =>
    fakeEvents([
      { type: 'text_delta', text: 'done' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'done' },
    ])

  const driver = new EvalDriver()
  const result = await driver.runTask(taskWithExpect, tmpDir, { llmMode: 'live' }, mockQL)

  expect(result.turns[0]!.expectTools).toEqual(['Edit', 'Bash'])
})

test('difficulty 被记录到结果', async () => {
  const mockQL = (_opts: QueryLoopOpts): AsyncGenerator<QueryEvent> =>
    fakeEvents([
      { type: 'text_delta', text: 'x' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'done' },
    ])

  const driver = new EvalDriver()
  const result = await driver.runTask(
    { ...simpleTask, difficulty: 'hard' },
    tmpDir,
    { llmMode: 'live' },
    mockQL,
  )

  expect(result.difficulty).toBe('hard')
})
