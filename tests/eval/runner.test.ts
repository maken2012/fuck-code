// tests/eval/runner.test.ts
// EvalRunner 测试：用 mock driver + mock judge 验证编排逻辑。
// 不调真实 LLM/API。
import { test, expect } from 'bun:test'
import type { EvalTask, TaskRunResult, RunnerOpts, EvalReport } from '@/eval/types.js'
import { EvalRunner } from '@/eval/runner.js'
import { EvalDriver } from '@/eval/driver.js'
import type { DriverOpts } from '@/eval/types.js'
import type { QueryEvent } from '@/agent/types.js'
import type { QueryLoopOpts } from '@/agent/queryLoop.js'

const baseTask: EvalTask = {
  id: 't1',
  name: '测试任务1',
  description: '',
  difficulty: 'easy',
  workspace: { type: 'scratch', files: { 'main.ts': 'console.log(1)' } },
  turns: [{ prompt: '干活' }],
  judge: { type: 'behavior', assertions: [{ kind: 'file-exists', path: 'main.ts' }] },
}

// 构造一个 mock queryLoop：模型只说"done"，不做任何操作
async function* mockQL(_opts: QueryLoopOpts): AsyncGenerator<QueryEvent> {
  yield { type: 'text_delta', text: 'done' }
  yield { type: 'turn_end', stopReason: 'end_turn' }
  yield { type: 'usage', input: 10, output: 5, cacheRead: 0 }
  yield { type: 'done' }
}

// 注入 mockQL 的 driver
function makeMockDriver(): EvalDriver {
  const driver = new EvalDriver()
  // 用 _queryLoopOverride 让 driver 跳过真实初始化
  const origRunTask = driver.runTask.bind(driver)
  driver.runTask = (task, workspaceDir, opts, _override) =>
    origRunTask(task, workspaceDir, opts, mockQL)
  return driver
}

const baseOpts: RunnerOpts = {
  llmMode: 'live',
  cleanup: false, // 保留工作区让 judge 能检查
}

test('单任务：pass 路径（behavior 判定 file-exists 成功）', async () => {
  const driver = makeMockDriver()
  const runner = new EvalRunner([baseTask], baseOpts, undefined, driver)
  const report = await runner.run()

  expect(report.results.length).toBe(1)
  // scratch 创建了 main.ts，behavior file-exists 应通过
  expect(report.results[0]!.status).toBe('pass')
  expect(report.summary.passed).toBe(1)
  expect(report.summary.passRate).toBe(1)
})

test('单任务：fail 路径（behavior file-not-exists 但文件不存在反而不对）', async () => {
  const failTask: EvalTask = {
    ...baseTask,
    judge: {
      type: 'behavior',
      assertions: [{ kind: 'file-not-exists', path: 'main.ts' }], // 但 main.ts 被 scratch 创建了
    },
  }
  const driver = makeMockDriver()
  const runner = new EvalRunner([failTask], baseOpts, undefined, driver)
  const report = await runner.run()

  expect(report.results[0]!.status).toBe('fail')
  expect(report.summary.failed).toBe(1)
})

test('多任务：汇总统计正确', async () => {
  const tasks: EvalTask[] = [
    { ...baseTask, id: 't1', name: 'pass1', difficulty: 'easy' },
    { ...baseTask, id: 't2', name: 'pass2', difficulty: 'medium' },
    { ...baseTask, id: 't3', name: 'fail1', difficulty: 'easy',
      judge: { type: 'behavior', assertions: [{ kind: 'file-exists', path: 'nope.ts' }] } },
  ]
  const driver = makeMockDriver()
  const runner = new EvalRunner(tasks, baseOpts, undefined, driver)
  const report = await runner.run()

  expect(report.summary.total).toBe(3)
  expect(report.summary.passed).toBe(2)
  expect(report.summary.failed).toBe(1)
  expect(report.summary.passRate).toBeCloseTo(0.667, 2)
})

test('按难度分组统计', async () => {
  const tasks: EvalTask[] = [
    { ...baseTask, id: 't1', difficulty: 'easy' },
    { ...baseTask, id: 't2', difficulty: 'easy',
      judge: { type: 'behavior', assertions: [{ kind: 'file-exists', path: 'nope.ts' }] } },
    { ...baseTask, id: 't3', difficulty: 'hard' },
  ]
  const driver = makeMockDriver()
  const runner = new EvalRunner(tasks, baseOpts, undefined, driver)
  const report = await runner.run()

  expect(report.summary.byDifficulty.easy).toEqual({ total: 2, passed: 1, passRate: 0.5 })
  expect(report.summary.byDifficulty.hard).toEqual({ total: 1, passed: 1, passRate: 1 })
})

test('token 汇总', async () => {
  const driver = makeMockDriver()
  const runner = new EvalRunner([baseTask], baseOpts, undefined, driver)
  const report = await runner.run()

  // mockQL 每次返回 input:10 output:5
  expect(report.summary.totalInputTokens).toBe(10)
  expect(report.summary.totalOutputTokens).toBe(5)
})

test('回调被正确触发', async () => {
  const starts: string[] = []
  const completes: string[] = []

  const driver = makeMockDriver()
  const runner = new EvalRunner(
    [baseTask],
    baseOpts,
    {
      onTaskStart: (task) => starts.push(task.id),
      onTaskComplete: (result) => completes.push(result.taskId),
    },
    driver,
  )
  await runner.run()

  expect(starts).toEqual(['t1'])
  expect(completes).toEqual(['t1'])
})

test('多轮任务的 turns 都被执行', async () => {
  const multiTask: EvalTask = {
    ...baseTask,
    turns: [{ prompt: '第一步' }, { prompt: '第二步' }],
  }
  const driver = makeMockDriver()
  const runner = new EvalRunner([multiTask], baseOpts, undefined, driver)
  const report = await runner.run()

  expect(report.results[0]!.turns.length).toBe(2)
  expect(report.results[0]!.turns[0]!.text).toBe('done')
  expect(report.results[0]!.turns[1]!.text).toBe('done')
})

test('composite judge：behavior 通过 + test 命令通过', async () => {
  const task: EvalTask = {
    ...baseTask,
    workspace: {
      type: 'scratch',
      files: {
        'pass.test.ts': `import { test, expect } from 'bun:test'\ntest('p', () => expect(1).toBe(1))`,
      },
    },
    judge: {
      type: 'composite',
      requireAll: true,
      judges: [
        { type: 'test', command: 'bun test', timeoutMs: 30000 },
        { type: 'behavior', assertions: [{ kind: 'file-exists', path: 'pass.test.ts' }] },
      ],
    },
  }
  const driver = makeMockDriver()
  const runner = new EvalRunner([task], baseOpts, undefined, driver)
  const report = await runner.run()

  expect(report.results[0]!.status).toBe('pass')
})

test('cleanup=true 时清理工作区', async () => {
  const { fileExists } = await import('@/eval/isolation.js')
  let workspaceDir = ''

  const driver = makeMockDriver()
  const runner = new EvalRunner(
    [baseTask],
    { ...baseOpts, cleanup: true },
    {
      onTaskComplete: (result) => { workspaceDir = result.workspaceDir },
    },
    driver,
  )
  await runner.run()

  // 清理后工作区应不存在
  expect(workspaceDir).toBeTruthy()
  expect(await fileExists(workspaceDir)).toBe(false)
})
