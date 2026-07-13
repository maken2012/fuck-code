// tests/agent/workflow.test.ts
// 工作流层测试。用 _queryLoopOverride 注入 mock，验证四阶段编排逻辑。
import { test, expect } from 'bun:test'
import { runWorkflow } from '@/agent/workflow.js'
import type { QueryEvent } from '@/agent/types.js'

// 构造假 queryLoop，每个阶段返回不同文本
function makeFakeQueryLoop(): (o: object) => AsyncGenerator<QueryEvent> {
  let callCount = 0
  return async function* (opts: object) {
    callCount++
    const stage = (opts as { system: string }).system
    let text = ''
    if (stage.includes('UNDERSTAND')) text = '## 计划\n1. 改 foo\n2. 改 bar'
    else if (stage.includes('IMPLEMENT')) text = '已改 foo.ts 和 bar.ts'
    else if (stage.includes('VERIFY')) text = '测试通过 ✓'
    else if (stage.includes('SUMMARIZE')) text = '改了 foo.ts/bar.ts，测试通过'
    yield { type: 'text_delta', text }
    yield { type: 'turn_end', stopReason: 'end_turn' }
    yield { type: 'done' }
  }
}

test('工作流走完四阶段', async () => {
  const events: string[] = []
  const stageOrder: string[] = []
  for await (const e of runWorkflow({
    requirement: '加个登录',
    model: 'm',
    signal: new AbortController().signal,
    cwd: '/tmp',
    config: { maxTokens: 8192, contextWindow: 200000, permissions: { allow: [], ask: [], deny: [] } },
    _queryLoopOverride: makeFakeQueryLoop(),
  })) {
    events.push(e.type)
    if (e.type === 'workflow_stage_start') stageOrder.push(e.stage)
  }
  // 应有 4 个 stage_start + 4 个 stage_end + 1 个 done
  expect(events.filter((e) => e === 'workflow_stage_start').length).toBe(4)
  expect(events.filter((e) => e === 'workflow_stage_end').length).toBe(4)
  expect(events).toContain('workflow_done')
  // 四阶段顺序
  expect(stageOrder).toEqual(['understand', 'implement', 'verify', 'summarize'])
})

test('阶段间上下文传递（implement 能看到 understand 输出）', async () => {
  let implementInput = ''
  const fake = async function* (opts: object): AsyncGenerator<QueryEvent> {
    const o = opts as { system: string; userInput: string }
    if (o.system.includes('IMPLEMENT')) {
      implementInput = o.userInput
    }
    yield { type: 'text_delta', text: 'x' }
    yield { type: 'done' }
  }
  for await (const _ of runWorkflow({
    requirement: '需求X',
    model: 'm',
    signal: new AbortController().signal,
    cwd: '/tmp',
    config: { maxTokens: 8192, contextWindow: 200000, permissions: { allow: [], ask: [], deny: [] } },
    _queryLoopOverride: fake,
  })) {
    void _
  }
  expect(implementInput).toContain('需求X')
  expect(implementInput).toContain('understand 阶段输出')
})

test('abort 时停止并报告已完成阶段', async () => {
  const ac = new AbortController()
  let stageCount = 0
  const fake = async function* (opts: object): AsyncGenerator<QueryEvent> {
    stageCount++
    if (stageCount === 2) {
      // implement 阶段时 abort
      ac.abort()
    }
    yield { type: 'text_delta', text: 'x' }
    yield { type: 'done' }
  }
  const events: string[] = []
  for await (const e of runWorkflow({
    requirement: 'x',
    model: 'm',
    signal: ac.signal,
    cwd: '/tmp',
    config: { maxTokens: 8192, contextWindow: 200000, permissions: { allow: [], ask: [], deny: [] } },
    _queryLoopOverride: fake,
  })) {
    events.push(e.type)
  }
  expect(events).toContain('workflow_aborted')
  // 至少完成了 understand
  expect(events).toContain('workflow_stage_end')
})
