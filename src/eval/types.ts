// src/eval/types.ts
// Eval harness 的核心类型契约。
// 任务定义 → 驱动执行 → 判定 → 结果，全流程的数据结构都在这里。
//
// 设计原则：
// - 任务定义（EvalTask）用 JSON 编写，Zod 校验（taskSchema.ts）
// - 运行结果（TaskRunResult）是程序内部数据结构，从事件流聚合而来
// - 判定器（Judge）有统一接口，4 种实现 + composite 组合

// ─── 工作区设置 ───────────────────────────────────────────
// 3 种隔离模式，从轻到重。

export type WorkspaceSetup =
  | ScratchWorkspace       // 空目录 + 手写文件（最快，适合算法题）
  | FromRepoWorkspace      // git clone（适合真实仓库任务）
  | FromSnapshotWorkspace  // 复制本地目录（适合多轮累积任务）

/** scratch：mkdtemp 后写入 files 映射 */
export interface ScratchWorkspace {
  type: 'scratch'
  /** 相对路径 → 文件内容。路径可含子目录（如 src/index.ts） */
  files: Record<string, string>
}

/** from-repo：git clone 后可选 checkout 指定 commit */
export interface FromRepoWorkspace {
  type: 'from-repo'
  /** git 仓库地址（HTTPS 或本地路径） */
  repo: string
  /** 可选：checkout 到指定 commit/branch/tag（默认用默认分支 HEAD） */
  commit?: string
  /** clone 深度（默认 1，浅克隆提速） */
  depth?: number
}

/** from-snapshot：递归复制一个本地目录作为起点 */
export interface FromSnapshotWorkspace {
  type: 'from-snapshot'
  /** 本地目录绝对路径或相对路径 */
  snapshotDir: string
}

// ─── 对话轮次 ─────────────────────────────────────────────

export interface Turn {
  /** 用户输入 prompt */
  prompt: string
  /**
   * 软断言：期望本轮模型调用的工具名列表。
   * 仅记录到结果里（toolsCalled vs expectTools），不影响 pass/fail。
   * 用于分析模型行为，比如"修 bug 任务期望用了 Read+Edit"。
   */
  expectTools?: string[]
}

// ─── 判定规格 ─────────────────────────────────────────────

export type JudgeSpec =
  | TestJudgeSpec
  | LintJudgeSpec
  | BehaviorJudgeSpec
  | LlmJudgeSpec
  | MultiRubricJudgeSpec
  | CompositeJudgeSpec

/** test：跑命令，exit 0 = pass（最可靠的判定方式） */
export interface TestJudgeSpec {
  type: 'test'
  /** 在隔离工作区里执行的命令（如 bun test / npm test） */
  command: string
  /** 超时毫秒，默认 60000 */
  timeoutMs?: number
}

/** lint：类型检查/lint，默认 npx tsc --noEmit */
export interface LintJudgeSpec {
  type: 'lint'
  /** 自定义命令，不传默认 npx tsc --noEmit */
  command?: string
  /** 超时毫秒，默认 30000 */
  timeoutMs?: number
}

/** behavior：行为断言，检查文件状态或跑命令 */
export type BehaviorAssertion =
  | { kind: 'file-exists'; path: string }
  | { kind: 'file-not-exists'; path: string }
  | { kind: 'file-contains'; path: string; pattern: string }
  | { kind: 'file-not-contains'; path: string; pattern: string }
  | { kind: 'command-exits-zero'; command: string; timeoutMs?: number }

export interface BehaviorJudgeSpec {
  type: 'behavior'
  assertions: BehaviorAssertion[]
}

/** llm-judge：用独立 LLM 按 rubric 打分（适合开放性任务） */
export interface LlmJudgeSpec {
  type: 'llm-judge'
  /** 评分标准描述（会拼到 judge LLM 的 prompt 里） */
  rubric: string
  /** 指定 judge 模型（不传用 driver 同款模型） */
  model?: string
}

/** 评分维度（multi-rubric 用） */
export interface RubricDimension {
  /** 维度名，如"可扩展性" */
  name: string
  /** 权重（0-1，所有维度权重和应为 1） */
  weight: number
  /** 该维度的评分标准描述 */
  criteria: string
}

/** multi-rubric：多维度 rubric + LLM-judge（架构设计/需求分析类任务） */
export interface MultiRubricJudgeSpec {
  type: 'multi-rubric'
  /** 多个评分维度，每个有名称/权重/标准 */
  dimensions: RubricDimension[]
  /** 总分达到此阈值算 pass（0-1，默认 0.7） */
  passThreshold?: number
  /** 指定 judge 模型（不传用 driver 同款模型） */
  model?: string
}

/** composite：组合多个判定器 */
export interface CompositeJudgeSpec {
  type: 'composite'
  judges: JudgeSpec[]
  /** true=全部通过才算 pass（默认）；false=任一通过即 pass */
  requireAll?: boolean
}

// ─── 任务定义 ─────────────────────────────────────────────

export interface EvalTask {
  /** 唯一 id（用于结果索引） */
  id: string
  /** 任务名（报告里展示） */
  name: string
  /** 任务描述（给自己看） */
  description: string
  /** 难度（报告里分组统计用） */
  difficulty: 'easy' | 'medium' | 'hard'
  /** 工作区设置 */
  workspace: WorkspaceSetup
  /** 对话轮次。1 个=单轮；多个=累积引导式（同 session 内连续喂） */
  turns: Turn[]
  /** 判定方式 */
  judge: JudgeSpec
  /** 整个任务超时毫秒，默认 120000 */
  timeoutMs?: number
  /** queryLoop 内部单轮最大轮次（工具调用循环上限），默认 20 */
  maxTurns?: number
}

// ─── 运行结果 ─────────────────────────────────────────────

export interface TurnResult {
  /** 本轮用户输入 */
  prompt: string
  /** 模型文本输出（所有 text_delta 拼接） */
  text: string
  /** 本轮工具调用序列（按调用顺序，如 ['Read', 'Edit', 'Bash']） */
  toolsCalled: string[]
  /** 期望工具（来自 expectTools，可能 undefined） */
  expectTools?: string[]
  /** 本轮 token 消耗 */
  tokens: { input: number; output: number }
  /** 本轮耗时毫秒 */
  durationMs: number
  /** queryLoop 内部跑了多少轮（工具调用循环计数） */
  turnCount: number
}

export interface TaskRunResult {
  taskId: string
  taskName: string
  /** 任务难度（报告里分组统计用） */
  difficulty: 'easy' | 'medium' | 'hard'
  status: TaskStatus
  turns: TurnResult[]
  judgeResult: JudgeResult
  totalTokens: { input: number; output: number; cacheRead: number }
  durationMs: number
  /** 工作区目录（隔离的，判定后可清理） */
  workspaceDir: string
  /** 错误信息（status=error/timeout 时填） */
  error?: string
}

export type TaskStatus = 'pass' | 'fail' | 'error' | 'timeout'

export interface JudgeResult {
  pass: boolean
  /** 0-1 分数（llm-judge 用，其他固定 1.0/0.0） */
  score?: number
  /** 判定原因（报告里展示） */
  reason: string
  /** 详细信息（命令输出、断言明细等） */
  details?: unknown
  /** 多维度评分明细（multi-rubric 用） */
  dimensionScores?: DimensionScore[]
}

/** 单个维度的评分结果 */
export interface DimensionScore {
  name: string
  weight: number
  score: number
  reason: string
}

// ─── 评测报告 ─────────────────────────────────────────────

export interface EvalReport {
  /** 运行开始时间（ISO 字符串） */
  startedAt: string
  /** 总耗时毫秒 */
  durationMs: number
  /** 模型名 */
  model: string
  /** LLM 模式：live=真实API / record=录制 / replay=回放 */
  llmMode: LlmMode
  /** 每个任务的结果 */
  results: TaskRunResult[]
  /** 汇总统计 */
  summary: EvalSummary
}

export interface EvalSummary {
  total: number
  passed: number
  failed: number
  errored: number
  timedOut: number
  /** pass 率（0-1） */
  passRate: number
  /** 总 token */
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  /** 按难度分组 */
  byDifficulty: Record<string, { total: number; passed: number; passRate: number }>
}

export type LlmMode = 'live' | 'record' | 'replay'

// ─── Driver / Runner 选项 ─────────────────────────────────

export interface DriverOpts {
  /** 模型名（覆盖 config） */
  model?: string
  /** API key（覆盖 config） */
  apiKey?: string
  /** API baseURL（覆盖 config） */
  apiBaseUrl?: string
  /** provider 强制指定 */
  provider?: 'anthropic' | 'openai' | 'openai-compatible'
  /** LLM 模式：live=真实调用 / record=录制 / replay=回放 */
  llmMode: LlmMode
  /** replay 模式下的录制文件路径 */
  replayFile?: string
  /** record 模式下录制文件的写入路径 */
  recordFile?: string
  /** 超时毫秒（覆盖 task.timeoutMs） */
  timeoutMs?: number
}

export interface RunnerOpts {
  model?: string
  apiKey?: string
  apiBaseUrl?: string
  provider?: 'anthropic' | 'openai' | 'openai-compatible'
  llmMode: LlmMode
  /** replay 时需指定录制目录 */
  replayDir?: string
  /** record 时录制目录 */
  recordDir?: string
  /** 并发任务数（默认 1） */
  concurrency?: number
  /** 失败重试次数（默认 0） */
  retries?: number
  /** 超时覆盖 */
  timeoutMs?: number
  /** 运行后是否清理工作区（默认 true） */
  cleanup?: boolean
}
