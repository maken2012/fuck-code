// src/eval/taskSchema.ts
// 任务定义的 Zod 校验 schema。
// 单一真相源：类型从 schema 推导（z.infer），不手写重复。
//
// 用法：
//   const raw = JSON.parse(fs.readFileSync('task.json', 'utf8'))
//   const task = TaskSchema.parse(raw)  // 校验失败抛 ZodError，带详细路径
import { z } from 'zod'

// ─── 工作区设置 ───────────────────────────────────────────

export const ScratchWorkspaceSchema = z.object({
  type: z.literal('scratch'),
  files: z.record(z.string(), z.string()).describe('相对路径 → 文件内容'),
})

export const FromRepoWorkspaceSchema = z.object({
  type: z.literal('from-repo'),
  repo: z.string().min(1),
  commit: z.string().optional(),
  depth: z.number().int().positive().default(1),
})

export const FromSnapshotWorkspaceSchema = z.object({
  type: z.literal('from-snapshot'),
  snapshotDir: z.string().min(1),
})

export const WorkspaceSetupSchema = z.discriminatedUnion('type', [
  ScratchWorkspaceSchema,
  FromRepoWorkspaceSchema,
  FromSnapshotWorkspaceSchema,
])

// ─── 对话轮次 ─────────────────────────────────────────────

export const TurnSchema = z.object({
  prompt: z.string().min(1),
  expectTools: z.array(z.string()).optional(),
})

// ─── 判定规格 ─────────────────────────────────────────────

export const TestJudgeSchema = z.object({
  type: z.literal('test'),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().default(60000),
})

export const LintJudgeSchema = z.object({
  type: z.literal('lint'),
  command: z.string().optional(),
  timeoutMs: z.number().int().positive().default(30000),
})

// behavior 的 5 种断言
export const BehaviorAssertionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file-exists'), path: z.string().min(1) }),
  z.object({ kind: z.literal('file-not-exists'), path: z.string().min(1) }),
  z.object({ kind: z.literal('file-contains'), path: z.string().min(1), pattern: z.string().min(1) }),
  z.object({ kind: z.literal('file-not-contains'), path: z.string().min(1), pattern: z.string().min(1) }),
  z.object({ kind: z.literal('command-exits-zero'), command: z.string().min(1), timeoutMs: z.number().int().positive().optional() }),
])

export const BehaviorJudgeSchema = z.object({
  type: z.literal('behavior'),
  assertions: z.array(BehaviorAssertionSchema).min(1),
})

export const LlmJudgeSchema = z.object({
  type: z.literal('llm-judge'),
  rubric: z.string().min(1),
  model: z.string().optional(),
})

export const RubricDimensionSchema = z.object({
  name: z.string().min(1),
  weight: z.number().min(0).max(1),
  criteria: z.string().min(1),
})

export const MultiRubricJudgeSchema = z.object({
  type: z.literal('multi-rubric'),
  dimensions: z.array(RubricDimensionSchema).min(1),
  passThreshold: z.number().min(0).max(1).default(0.7),
  model: z.string().optional(),
})

// recursive：composite 里可以嵌 composite
export const JudgeSpecSchema: z.ZodType<z.infer<typeof TestJudgeSchema> | z.infer<typeof LintJudgeSchema> | z.infer<typeof BehaviorJudgeSchema> | z.infer<typeof LlmJudgeSchema> | z.infer<typeof MultiRubricJudgeSchema> | { type: 'composite'; judges: any[]; requireAll?: boolean }> =
  z.lazy(() =>
    z.discriminatedUnion('type', [
      TestJudgeSchema,
      LintJudgeSchema,
      BehaviorJudgeSchema,
      LlmJudgeSchema,
      MultiRubricJudgeSchema,
      z.object({
        type: z.literal('composite'),
        judges: z.array(JudgeSpecSchema).min(1),
        requireAll: z.boolean().default(true),
      }),
    ]),
  )

// ─── 任务定义 ─────────────────────────────────────────────

export const TaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  workspace: WorkspaceSetupSchema,
  turns: z.array(TurnSchema).min(1),
  judge: JudgeSpecSchema,
  timeoutMs: z.number().int().positive().default(120000),
  maxTurns: z.number().int().positive().default(20),
})

// 导出推导类型（与 types.ts 手写类型一致，Zod 是运行时真相源）
export type TaskFromSchema = z.infer<typeof TaskSchema>

/** 校验并解析任务 JSON，失败抛 ZodError（带字段路径） */
export function parseTask(raw: unknown): TaskFromSchema {
  return TaskSchema.parse(raw)
}

/** 安全校验：返回 [task, error] 元组，不抛异常 */
export function safeParseTask(raw: unknown): [TaskFromSchema | null, z.ZodError | null] {
  const result = TaskSchema.safeParse(raw)
  if (result.success) return [result.data, null]
  return [null, result.error]
}

/** 把 ZodError 格式化成人类可读的多行字符串 */
export function formatTaskErrors(error: z.ZodError): string {
  return error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n')
}
