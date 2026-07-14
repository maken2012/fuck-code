// tests/agent/goalRunner.test.ts
import { test, expect } from 'bun:test'
import { runGoal } from '@/agent/goalRunner.js'
import type { QueryEvent } from '@/agent/types.js'

const baseOpts = {
  model: 'm',
  signal: new AbortController().signal,
  cwd: '/tmp',
  config: { maxTokens: 8192, contextWindow: 200000, permissions: { allow: [], ask: [], deny: [] } },
}

test('goal 达成后停止', async () => {
  let turn = 0
  const events: string[] = []
  for await (const e of runGoal({
    ...baseOpts,
    goal: '测试全过',
    maxTurns: 5,
    _queryLoopOverride: async function* (): AsyncGenerator<QueryEvent> {
      turn++
      yield { type: 'text_delta', text: `第${turn}轮工作` }
      yield { type: 'done' }
    },
    // 第 2 轮后判定达成
    _checkOverride: async (_goal, workLog) => workLog.includes('第2轮'),
  })) {
    events.push(e.type)
  }
  expect(turn).toBe(2) // 第 2 轮达成后停止
  expect(events).toContain('goal_achieved')
  expect(events).toContain('goal_turn_end')
})

test('goal 超过最大轮次', async () => {
  let turn = 0
  const events: string[] = []
  for await (const e of runGoal({
    ...baseOpts,
    goal: '永远达不到',
    maxTurns: 3,
    _queryLoopOverride: async function* (): AsyncGenerator<QueryEvent> {
      turn++
      yield { type: 'text_delta', text: `工作${turn}` }
      yield { type: 'done' }
    },
    _checkOverride: async () => false, // 永远不达成
  })) {
    events.push(e.type)
  }
  expect(turn).toBe(3)
  expect(events).toContain('goal_max_turns')
  expect(events).not.toContain('goal_achieved')
})

test('goal abort 时停止', async () => {
  const ac = new AbortController()
  let turn = 0
  const events: string[] = []
  for await (const e of runGoal({
    ...baseOpts,
    goal: 'x',
    maxTurns: 5,
    signal: ac.signal,
    _queryLoopOverride: async function* (): AsyncGenerator<QueryEvent> {
      turn++
      if (turn === 2) ac.abort()
      yield { type: 'text_delta', text: 'work' }
      yield { type: 'done' }
    },
    _checkOverride: async () => false,
  })) {
    events.push(e.type)
  }
  expect(events).toContain('goal_aborted')
})

test('goal_start 事件含目标和轮次', async () => {
  const events: { type: string; goal?: string; maxTurns?: number }[] = []
  for await (const e of runGoal({
    ...baseOpts,
    goal: '完成X',
    maxTurns: 1,
    _queryLoopOverride: async function* (): AsyncGenerator<QueryEvent> {
      yield { type: 'done' }
    },
    _checkOverride: async () => true,
  })) {
    events.push(e as { type: string; goal?: string; maxTurns?: number })
  }
  const start = events.find((e) => e.type === 'goal_start')
  expect(start?.goal).toBe('完成X')
  expect(start?.maxTurns).toBe(1)
})
