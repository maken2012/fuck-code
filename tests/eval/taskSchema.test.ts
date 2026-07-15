// tests/eval/taskSchema.test.ts
// 任务 schema 校验测试。
import { test, expect } from 'bun:test'
import { parseTask, safeParseTask, formatTaskErrors, TaskSchema } from '@/eval/taskSchema.js'

test('合法的 scratch 单轮任务通过校验', () => {
  const task = parseTask({
    id: 'test-1',
    name: '测试任务',
    description: 'desc',
    difficulty: 'easy',
    workspace: {
      type: 'scratch',
      files: { 'main.ts': 'console.log(1)' },
    },
    turns: [{ prompt: '干活' }],
    judge: { type: 'test', command: 'bun test' },
  })
  expect(task.id).toBe('test-1')
  expect(task.difficulty).toBe('easy')
  expect(task.timeoutMs).toBe(120000) // 默认值
  expect(task.maxTurns).toBe(20) // 默认值
})

test('from-repo workspace 带 commit 和 depth', () => {
  const task = parseTask({
    id: 'repo-task',
    name: 'repo 任务',
    description: '',
    difficulty: 'hard',
    workspace: {
      type: 'from-repo',
      repo: 'https://github.com/x/y.git',
      commit: 'abc123',
      depth: 5,
    },
    turns: [{ prompt: 'p' }],
    judge: { type: 'lint' },
  })
  expect(task.workspace.type).toBe('from-repo')
  if (task.workspace.type === 'from-repo') {
    expect(task.workspace.commit).toBe('abc123')
    expect(task.workspace.depth).toBe(5)
  }
})

test('composite judge 嵌套校验', () => {
  const task = parseTask({
    id: 'composite',
    name: '复合判定',
    description: '',
    difficulty: 'medium',
    workspace: { type: 'scratch', files: {} },
    turns: [{ prompt: 'p' }],
    judge: {
      type: 'composite',
      requireAll: true,
      judges: [
        { type: 'test', command: 'bun test' },
        {
          type: 'behavior',
          assertions: [
            { kind: 'file-exists', path: 'a.ts' },
            { kind: 'file-contains', path: 'b.ts', pattern: 'class' },
          ],
        },
        { type: 'lint', command: 'tsc' },
      ],
    },
  })
  expect(task.judge.type).toBe('composite')
})

test('llm-judge 判定器', () => {
  const task = parseTask({
    id: 'llm',
    name: 'LLM judge',
    description: '',
    difficulty: 'medium',
    workspace: { type: 'scratch', files: {} },
    turns: [{ prompt: 'p' }],
    judge: { type: 'llm-judge', rubric: '代码要清晰' },
  })
  expect(task.judge.type).toBe('llm-judge')
})

test('多轮任务 turns 数组', () => {
  const task = parseTask({
    id: 'multi',
    name: '多轮',
    description: '',
    difficulty: 'medium',
    workspace: { type: 'scratch', files: {} },
    turns: [
      { prompt: '第一步' },
      { prompt: '第二步', expectTools: ['Edit'] },
      { prompt: '第三步' },
    ],
    judge: { type: 'test', command: 'bun test' },
  })
  expect(task.turns.length).toBe(3)
  expect(task.turns[1]?.expectTools).toEqual(['Edit'])
})

test('缺少必填字段报错', () => {
  const [task, err] = safeParseTask({
    id: 'x',
    // name 缺失
    description: '',
    difficulty: 'easy',
    workspace: { type: 'scratch', files: {} },
    turns: [{ prompt: 'p' }],
    judge: { type: 'test', command: 'bun test' },
  })
  expect(task).toBeNull()
  expect(err).not.toBeNull()
  const msg = err ? formatTaskErrors(err) : ''
  expect(msg).toContain('name')
})

test('difficulty 非法值报错', () => {
  const [, err] = safeParseTask({
    id: 'x',
    name: 'n',
    description: '',
    difficulty: 'impossible', // 非法
    workspace: { type: 'scratch', files: {} },
    turns: [{ prompt: 'p' }],
    judge: { type: 'test', command: 'bun test' },
  })
  expect(err).not.toBeNull()
})

test('turns 为空数组报错', () => {
  const [, err] = safeParseTask({
    id: 'x',
    name: 'n',
    description: '',
    difficulty: 'easy',
    workspace: { type: 'scratch', files: {} },
    turns: [], // 空
    judge: { type: 'test', command: 'bun test' },
  })
  expect(err).not.toBeNull()
})

test('workspace type 非法报错', () => {
  const [, err] = safeParseTask({
    id: 'x',
    name: 'n',
    description: '',
    difficulty: 'easy',
    workspace: { type: 'invalid', files: {} },
    turns: [{ prompt: 'p' }],
    judge: { type: 'test', command: 'bun test' },
  })
  expect(err).not.toBeNull()
})

test('behavior assertions 为空报错', () => {
  const [, err] = safeParseTask({
    id: 'x',
    name: 'n',
    description: '',
    difficulty: 'easy',
    workspace: { type: 'scratch', files: {} },
    turns: [{ prompt: 'p' }],
    judge: { type: 'behavior', assertions: [] },
  })
  expect(err).not.toBeNull()
})

test('读取真实任务文件 01-add-function 通过校验', async () => {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const raw = await readFile(join('src/eval/tasks/01-add-function.task.json'), 'utf8')
  const task = parseTask(JSON.parse(raw))
  expect(task.id).toBe('01-add-function')
  expect(task.turns.length).toBe(1)
  expect(task.judge.type).toBe('test')
})

test('读取真实任务文件 04-multi-turn-accumulate 通过校验', async () => {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const raw = await readFile(join('src/eval/tasks/04-multi-turn-accumulate.task.json'), 'utf8')
  const task = parseTask(JSON.parse(raw))
  expect(task.id).toBe('04-multi-turn-accumulate')
  expect(task.turns.length).toBe(4)
  expect(task.judge.type).toBe('composite')
})

// ─── multi-rubric 校验 ─────────────────────────────────────

test('multi-rubric judge 校验通过', () => {
  const task = parseTask({
    id: 'mr',
    name: '架构设计',
    description: '',
    difficulty: 'hard',
    workspace: { type: 'scratch', files: {} },
    turns: [{ prompt: '设计缓存系统' }],
    judge: {
      type: 'multi-rubric',
      passThreshold: 0.65,
      dimensions: [
        { name: '可扩展性', weight: 0.3, criteria: '策略模式' },
        { name: '正确性', weight: 0.25, criteria: '逻辑正确' },
        { name: '接口设计', weight: 0.25, criteria: '清晰' },
        { name: '文档', weight: 0.2, criteria: '有说明' },
      ],
    },
  })
  expect(task.judge.type).toBe('multi-rubric')
  if (task.judge.type === 'multi-rubric') {
    expect(task.judge.dimensions.length).toBe(4)
    expect(task.judge.passThreshold).toBe(0.65)
  }
})

test('multi-rubric：dimensions 为空报错', () => {
  const [, err] = safeParseTask({
    id: 'x', name: 'n', description: '', difficulty: 'hard',
    workspace: { type: 'scratch', files: {} },
    turns: [{ prompt: 'p' }],
    judge: { type: 'multi-rubric', dimensions: [] },
  })
  expect(err).not.toBeNull()
})

test('multi-rubric：weight 超出 0-1 报错', () => {
  const [, err] = safeParseTask({
    id: 'x', name: 'n', description: '', difficulty: 'hard',
    workspace: { type: 'scratch', files: {} },
    turns: [{ prompt: 'p' }],
    judge: {
      type: 'multi-rubric',
      dimensions: [{ name: 'x', weight: 1.5, criteria: 'c' }],
    },
  })
  expect(err).not.toBeNull()
})

test('multi-rubric 嵌套在 composite 里', () => {
  const task = parseTask({
    id: 'nested',
    name: '嵌套',
    description: '',
    difficulty: 'hard',
    workspace: { type: 'scratch', files: {} },
    turns: [{ prompt: 'p' }],
    judge: {
      type: 'composite',
      judges: [
        { type: 'multi-rubric', dimensions: [{ name: 'x', weight: 1, criteria: 'c' }] },
        { type: 'behavior', assertions: [{ kind: 'file-exists', path: 'a' }] },
      ],
    },
  })
  expect(task.judge.type).toBe('composite')
})
