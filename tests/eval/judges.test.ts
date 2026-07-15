// tests/eval/judges.test.ts
// 判定器测试：TestJudge / BehaviorJudge / CompositeJudge。
// LlmJudge 需要真实 API，只测错误路径。
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import type { JudgeContext } from '@/eval/judges/types.js'
import type { EvalTask } from '@/eval/types.js'
import { TestJudge } from '@/eval/judges/testJudge.js'
import { BehaviorJudge } from '@/eval/judges/behaviorJudge.js'
import { CompositeJudge } from '@/eval/judges/compositeJudge.js'
import { LlmJudge } from '@/eval/judges/llmJudge.js'
import { createJudge } from '@/eval/judges/types.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', `fc-eval-judge-test-${process.pid}-${Date.now()}`)

beforeEach(async () => {
  await mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function makeCtx(workspaceDir: string): JudgeContext {
  return {
    workspaceDir,
    task: { id: 't', name: 't', description: '', difficulty: 'easy', workspace: { type: 'scratch', files: {} }, turns: [], judge: { type: 'test', command: '' } } as EvalTask,
    turnResults: [],
    finalText: '',
  }
}

// ─── TestJudge ─────────────────────────────────────────────

test('TestJudge：成功命令 pass', async () => {
  const judge = new TestJudge('echo ok', 5000)
  const result = await judge.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(true)
  expect(result.score).toBe(1)
})

test('TestJudge：失败命令 fail', async () => {
  const judge = new TestJudge('exit 1', 5000)
  const result = await judge.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(false)
  expect(result.score).toBe(0)
  expect(result.reason).toContain('exit')
})

test('TestJudge：超时 fail', async () => {
  const judge = new TestJudge('sleep 5', 500) // 500ms 超时
  const result = await judge.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(false)
  expect(result.reason).toContain('超时')
})

test('TestJudge：bun test 成功', async () => {
  // 准备一个会通过的测试
  const wsDir = join(tmpDir, 'pass-test')
  await mkdir(wsDir, { recursive: true })
  await writeFile(join(wsDir, 'pass.test.ts'), `import { test, expect } from 'bun:test'\ntest('pass', () => { expect(1+1).toBe(2) })`)

  const judge = new TestJudge('bun test', 30000)
  const result = await judge.judge(makeCtx(wsDir))
  expect(result.pass).toBe(true)
})

test('TestJudge：bun test 失败', async () => {
  const wsDir = join(tmpDir, 'fail-test')
  await mkdir(wsDir, { recursive: true })
  await writeFile(join(wsDir, 'fail.test.ts'), `import { test, expect } from 'bun:test'\ntest('fail', () => { expect(1+1).toBe(3) })`)

  const judge = new TestJudge('bun test', 30000)
  const result = await judge.judge(makeCtx(wsDir))
  expect(result.pass).toBe(false)
  expect(result.reason).toContain('退出码')
})

// ─── BehaviorJudge ─────────────────────────────────────────

test('BehaviorJudge：file-exists 通过', async () => {
  await writeFile(join(tmpDir, 'exists.ts'), 'content')
  const judge = new BehaviorJudge([{ kind: 'file-exists', path: 'exists.ts' }])
  const result = await judge.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(true)
})

test('BehaviorJudge：file-exists 失败', async () => {
  const judge = new BehaviorJudge([{ kind: 'file-exists', path: 'nope.ts' }])
  const result = await judge.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(false)
  expect(result.reason).toContain('不存在')
})

test('BehaviorJudge：file-not-exists 通过（文件确实不存在）', async () => {
  const judge = new BehaviorJudge([{ kind: 'file-not-exists', path: 'nope.ts' }])
  const result = await judge.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(true)
})

test('BehaviorJudge：file-contains 正则匹配', async () => {
  await writeFile(join(tmpDir, 'code.ts'), 'export class Foo { }')
  const judge = new BehaviorJudge([
    { kind: 'file-contains', path: 'code.ts', pattern: 'class\\s+Foo' },
  ])
  const result = await judge.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(true)
})

test('BehaviorJudge：file-contains 字符串匹配（非法正则降级）', async () => {
  await writeFile(join(tmpDir, 'code.ts'), 'function add(a, b) { return a + b }')
  // pattern 不是合法正则（含未闭合的括号），应降级为字符串匹配
  const judge = new BehaviorJudge([
    { kind: 'file-contains', path: 'code.ts', pattern: 'add(' },
  ])
  const result = await judge.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(true)
})

test('BehaviorJudge：file-not-contains 通过', async () => {
  await writeFile(join(tmpDir, 'code.ts'), 'const x = 1')
  const judge = new BehaviorJudge([
    { kind: 'file-not-contains', path: 'code.ts', pattern: 'TODO' },
  ])
  const result = await judge.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(true)
})

test('BehaviorJudge：file-not-contains 失败', async () => {
  await writeFile(join(tmpDir, 'code.ts'), '// TODO: fix this')
  const judge = new BehaviorJudge([
    { kind: 'file-not-contains', path: 'code.ts', pattern: 'TODO' },
  ])
  const result = await judge.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(false)
})

test('BehaviorJudge：command-exits-zero 成功', async () => {
  const judge = new BehaviorJudge([
    { kind: 'command-exits-zero', command: 'echo hi' },
  ])
  const result = await judge.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(true)
})

test('BehaviorJudge：command-exits-zero 失败', async () => {
  const judge = new BehaviorJudge([
    { kind: 'command-exits-zero', command: 'exit 3' },
  ])
  const result = await judge.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(false)
})

test('BehaviorJudge：多条断言全通过', async () => {
  await writeFile(join(tmpDir, 'main.ts'), 'export class App { }')
  const judge = new BehaviorJudge([
    { kind: 'file-exists', path: 'main.ts' },
    { kind: 'file-contains', path: 'main.ts', pattern: 'class' },
    { kind: 'file-not-exists', path: 'temp.ts' },
  ])
  const result = await judge.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(true)
})

test('BehaviorJudge：多条断言部分失败', async () => {
  await writeFile(join(tmpDir, 'main.ts'), 'export class App { }')
  const judge = new BehaviorJudge([
    { kind: 'file-exists', path: 'main.ts' }, // 通过
    { kind: 'file-exists', path: 'missing.ts' }, // 失败
  ])
  const result = await judge.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(false)
  expect(result.score).toBe(0.5) // 1/2
})

// ─── CompositeJudge ────────────────────────────────────────

test('CompositeJudge：requireAll=true 全通过', async () => {
  const mockPass = { judge: async () => ({ pass: true, score: 1, reason: 'ok' }) }
  const composite = new CompositeJudge([mockPass as never, mockPass as never], true)
  const result = await composite.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(true)
})

test('CompositeJudge：requireAll=true 部分失败', async () => {
  const mockPass = { judge: async () => ({ pass: true, score: 1, reason: 'ok' }) }
  const mockFail = { judge: async () => ({ pass: false, score: 0, reason: 'bad' }) }
  const composite = new CompositeJudge([mockPass as never, mockFail as never], true)
  const result = await composite.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(false)
})

test('CompositeJudge：requireAll=false 任一通过', async () => {
  const mockPass = { judge: async () => ({ pass: true, score: 1, reason: 'ok' }) }
  const mockFail = { judge: async () => ({ pass: false, score: 0, reason: 'bad' }) }
  const composite = new CompositeJudge([mockFail as never, mockPass as never], false)
  const result = await composite.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(true)
})

// ─── createJudge 工厂 ──────────────────────────────────────

test('createJudge：test 类型', async () => {
  const judge = await createJudge({ type: 'test', command: 'echo ok' })
  expect(judge).toBeInstanceOf(TestJudge)
})

test('createJudge：lint 类型默认 tsc', async () => {
  const judge = await createJudge({ type: 'lint' })
  expect(judge).toBeInstanceOf(TestJudge)
})

test('createJudge：behavior 类型', async () => {
  const judge = await createJudge({ type: 'behavior', assertions: [{ kind: 'file-exists', path: 'x' }] })
  expect(judge).toBeInstanceOf(BehaviorJudge)
})

test('createJudge：llm-judge 类型', async () => {
  const judge = await createJudge({ type: 'llm-judge', rubric: '清晰' })
  expect(judge).toBeInstanceOf(LlmJudge)
})

test('createJudge：composite 类型', async () => {
  const judge = await createJudge({
    type: 'composite',
    judges: [
      { type: 'test', command: 'echo ok' },
      { type: 'behavior', assertions: [{ kind: 'file-exists', path: 'x' }] },
    ],
  })
  expect(judge).toBeInstanceOf(CompositeJudge)
})

// ─── LlmJudge 错误路径 ─────────────────────────────────────

test('LlmJudge：无 apiKey 时调用失败返回 fail', async () => {
  const judge = new LlmJudge('清晰', { apiKey: undefined })
  const result = await judge.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(false)
  expect(result.reason).toContain('失败')
})

// ─── MultiRubricJudge ──────────────────────────────────────

import { MultiRubricJudge, alignDimensionScores, computeWeightedTotal } from '@/eval/judges/multiRubricJudge.js'
import type { RubricDimension } from '@/eval/types.js'

const sampleDims: RubricDimension[] = [
  { name: '可扩展性', weight: 0.3, criteria: '策略模式' },
  { name: '正确性', weight: 0.25, criteria: '逻辑正确' },
  { name: '接口设计', weight: 0.25, criteria: 'API 清晰' },
  { name: '文档', weight: 0.2, criteria: '有设计说明' },
]

test('alignDimensionScores：按 name 匹配分数', () => {
  const raw = [
    { name: '可扩展性', score: 0.9, reason: 'good' },
    { name: '正确性', score: 0.6, reason: '有小 bug' },
    { name: '接口设计', score: 0.8, reason: '清晰' },
    { name: '文档', score: 0.5, reason: '缺说明' },
  ]
  const aligned = alignDimensionScores(sampleDims, raw)
  expect(aligned.length).toBe(4)
  expect(aligned[0]!.score).toBe(0.9)
  expect(aligned[1]!.score).toBe(0.6)
  expect(aligned[0]!.weight).toBe(0.3)
})

test('alignDimensionScores：未匹配的维度分数为 0', () => {
  const raw = [
    { name: '可扩展性', score: 0.9, reason: 'good' },
  ]
  const aligned = alignDimensionScores(sampleDims, raw)
  expect(aligned[0]!.score).toBe(0.9)
  expect(aligned[1]!.score).toBe(0) // 正确性未匹配
  expect(aligned[1]!.reason).toBe('未评分')
})

test('alignDimensionScores：模糊匹配（name 包含）', () => {
  const raw = [
    { name: '可扩展性评估', score: 0.7, reason: 'ok' },
  ]
  const aligned = alignDimensionScores(sampleDims, raw)
  expect(aligned[0]!.score).toBe(0.7) // "可扩展性评估" 包含 "可扩展性"
})

test('alignDimensionScores：分数限制在 0-1', () => {
  const raw = [
    { name: '可扩展性', score: 1.5, reason: '超额' },
    { name: '正确性', score: -0.5, reason: '负分' },
  ]
  const aligned = alignDimensionScores(sampleDims, raw)
  expect(aligned[0]!.score).toBe(1) // 1.5 截断为 1
  expect(aligned[1]!.score).toBe(0) // -0.5 截断为 0
})

test('computeWeightedTotal：加权计算', () => {
  const scores = [
    { name: 'A', weight: 0.3, score: 1.0, reason: '' },
    { name: 'B', weight: 0.7, score: 0.5, reason: '' },
  ]
  // 1.0*0.3 + 0.5*0.7 = 0.3 + 0.35 = 0.65
  expect(computeWeightedTotal(scores)).toBeCloseTo(0.65, 5)
})

test('computeWeightedTotal：全满分', () => {
  const scores = sampleDims.map((d) => ({ ...d, score: 1.0, reason: '' }))
  expect(computeWeightedTotal(scores)).toBeCloseTo(1.0, 5)
})

test('computeWeightedTotal：全零分', () => {
  const scores = sampleDims.map((d) => ({ ...d, score: 0, reason: '' }))
  expect(computeWeightedTotal(scores)).toBe(0)
})

test('createJudge：multi-rubric 类型', async () => {
  const judge = await createJudge({
    type: 'multi-rubric',
    dimensions: sampleDims,
    passThreshold: 0.6,
  })
  expect(judge).toBeInstanceOf(MultiRubricJudge)
})

test('MultiRubricJudge：无 apiKey 时调用失败返回 fail', async () => {
  const judge = new MultiRubricJudge(sampleDims, 0.7, { apiKey: undefined })
  const result = await judge.judge(makeCtx(tmpDir))
  expect(result.pass).toBe(false)
  expect(result.reason).toContain('失败')
})
