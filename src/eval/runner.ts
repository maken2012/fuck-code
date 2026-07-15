// src/eval/runner.ts
// EvalRunner：评测编排器。
//
// 流程：遍历 tasks → WorkspaceManager.create → EvalDriver.runTask → createJudge → judge.judge → 汇总 → 清理
//
// 支持：
// - 并发（concurrency，默认 1，避免 token 爆炸）
// - 失败重试（retries，默认 0）
// - Ctrl+C 优雅清理所有工作区
// - 实时进度回调（onTaskComplete）
import type {
  EvalTask,
  TaskRunResult,
  EvalReport,
  EvalSummary,
  RunnerOpts,
  LlmMode,
} from '@/eval/types.js'
import { WorkspaceManager } from '@/eval/isolation.js'
import { EvalDriver } from '@/eval/driver.js'
import { createJudge } from '@/eval/judges/types.js'
import { getConfig } from '@/services/runtime.js'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'

export interface RunnerCallbacks {
  /** 任务开始时回调 */
  onTaskStart?: (task: EvalTask, index: number, total: number) => void
  /** 任务完成时回调（含结果） */
  onTaskComplete?: (result: TaskRunResult, index: number, total: number) => void
  /** 所有任务完成 */
  onAllComplete?: (report: EvalReport) => void
}

/**
 * EvalRunner：编排多个任务的评测。
 *
 * 用法：
 *   const runner = new EvalRunner(tasks, opts)
 *   const report = await runner.run()
 */
export class EvalRunner {
  private workspaceMgr = new WorkspaceManager()
  private driver: EvalDriver
  private cleanupHandlers: Array<() => Promise<void>> = []

  constructor(
    private readonly tasks: EvalTask[],
    private readonly opts: RunnerOpts,
    private readonly callbacks?: RunnerCallbacks,
    /** 可注入的 driver（测试用，生产用默认 EvalDriver） */
    driverOverride?: EvalDriver,
  ) {
    this.driver = driverOverride ?? new EvalDriver()
    // 注册 Ctrl+C 清理
    this.cleanupHandlers.push(() => this.workspaceMgr.cleanupAll())
    const sigintHandler = async () => {
      process.stderr.write('\n[eval] 中断，清理工作区...\n')
      await this.workspaceMgr.cleanupAll()
      process.exit(130)
    }
    process.once('SIGINT', sigintHandler)
  }

  async run(): Promise<EvalReport> {
    const startedAt = new Date().toISOString()
    const startMs = Date.now()

    // 加载 config 拿 apiKey/provider 等
    const config = await getConfig().catch(() => null)
    const model = this.opts.model ?? config?.value.model ?? 'claude-sonnet-4-5-20250929'
    const apiKey = this.opts.apiKey ?? config?.value.apiKey
    const apiBaseUrl = this.opts.apiBaseUrl ?? config?.value.apiBaseUrl
    const provider = this.opts.provider ?? config?.value.provider

    // 确保 record/replay 目录存在
    if (this.opts.recordDir) await mkdir(this.opts.recordDir, { recursive: true }).catch(() => {})

    const concurrency = this.opts.concurrency ?? 1
    const results: TaskRunResult[] = []

    // 分批并发执行
    for (let i = 0; i < this.tasks.length; i += concurrency) {
      const batch = this.tasks.slice(i, i + concurrency)
      const batchResults = await Promise.all(
        batch.map((task, batchIdx) => {
          const globalIdx = i + batchIdx
          return this.runSingleTask(task, globalIdx, this.tasks.length, {
            model,
            apiKey,
            apiBaseUrl,
            provider,
          })
        }),
      )
      results.push(...batchResults)
    }

    const durationMs = Date.now() - startMs
    const summary = this.computeSummary(results)

    const report: EvalReport = {
      startedAt,
      durationMs,
      model,
      llmMode: this.opts.llmMode,
      results,
      summary,
    }

    // 清理工作区（opts.cleanup 默认 true）
    if (this.opts.cleanup !== false) {
      await this.workspaceMgr.cleanupAll()
    }

    this.callbacks?.onAllComplete?.(report)
    return report
  }

  /** 跑单个任务（含重试） */
  private async runSingleTask(
    task: EvalTask,
    index: number,
    total: number,
    configCtx: { model: string; apiKey?: string; apiBaseUrl?: string; provider?: string },
  ): Promise<TaskRunResult> {
    const maxAttempts = 1 + (this.opts.retries ?? 0)
    let lastResult: TaskRunResult | undefined

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      this.callbacks?.onTaskStart?.(task, index, total)

      // 创建隔离工作区
      const workspaceDir = await this.workspaceMgr.create(task.workspace, task.id)

      // record/replay 文件路径
      const modePath = this.computeModePath(task.id, configCtx.model)

      try {
        // 跑 driver
        const driverOpts = {
          model: configCtx.model,
          apiKey: configCtx.apiKey,
          apiBaseUrl: configCtx.apiBaseUrl,
          provider: configCtx.provider as 'anthropic' | 'openai' | 'openai-compatible' | undefined,
          llmMode: this.opts.llmMode,
          timeoutMs: this.opts.timeoutMs ?? task.timeoutMs,
          ...(modePath ? (this.opts.llmMode === 'record' ? { recordFile: modePath } : { replayFile: modePath }) : {}),
        }

        let result = await this.driver.runTask(task, workspaceDir, driverOpts)

        // 如果 driver 没出错（status 不是 error/timeout），跑判定
        if (result.status !== 'error' && result.status !== 'timeout') {
          const judge = await createJudge(task.judge, {
            apiKey: configCtx.apiKey,
            apiBaseUrl: configCtx.apiBaseUrl,
            provider: configCtx.provider,
            defaultModel: configCtx.model,
          })

          const finalText = result.turns.length > 0
            ? result.turns[result.turns.length - 1]!.text
            : ''

          const judgeResult = await judge.judge({
            workspaceDir,
            task,
            turnResults: result.turns,
            finalText,
          })

          result = {
            ...result,
            judgeResult,
            status: judgeResult.pass ? 'pass' : 'fail',
          }
        }

        lastResult = result
        this.callbacks?.onTaskComplete?.(result, index, total)

        // 成功就不再重试
        if (result.status === 'pass') break

        // 失败/错误：清理这个工作区（重试会创建新的）
        if (this.opts.cleanup !== false) {
          await this.workspaceMgr.cleanup(workspaceDir).catch(() => {})
        }
      } catch (e) {
        lastResult = {
          taskId: task.id,
          taskName: task.name,
          difficulty: task.difficulty,
          status: 'error',
          turns: [],
          judgeResult: { pass: false, reason: '任务执行异常' },
          totalTokens: { input: 0, output: 0, cacheRead: 0 },
          durationMs: 0,
          workspaceDir,
          error: e instanceof Error ? e.message : String(e),
        }
        this.callbacks?.onTaskComplete?.(lastResult, index, total)
      }
    }

    return lastResult!
  }

  /** 计算 record/replay 文件路径 */
  private computeModePath(taskId: string, model: string): string | undefined {
    if (this.opts.llmMode === 'record' && this.opts.recordDir) {
      return join(this.opts.recordDir, `${taskId}.jsonl`)
    }
    if (this.opts.llmMode === 'replay' && this.opts.replayDir) {
      return join(this.opts.replayDir, `${taskId}.jsonl`)
    }
    return undefined
  }

  /** 汇总统计 */
  private computeSummary(results: TaskRunResult[]): EvalSummary {
    const total = results.length
    const passed = results.filter((r) => r.status === 'pass').length
    const failed = results.filter((r) => r.status === 'fail').length
    const errored = results.filter((r) => r.status === 'error').length
    const timedOut = results.filter((r) => r.status === 'timeout').length

    const totalInputTokens = results.reduce((s, r) => s + r.totalTokens.input, 0)
    const totalOutputTokens = results.reduce((s, r) => s + r.totalTokens.output, 0)
    const totalCacheReadTokens = results.reduce((s, r) => s + r.totalTokens.cacheRead, 0)

    // 按难度分组
    const byDifficulty: Record<string, { total: number; passed: number; passRate: number }> = {}
    for (const result of results) {
      const task = this.tasks.find((t) => t.id === result.taskId)
      const diff = task?.difficulty ?? 'unknown'
      if (!byDifficulty[diff]) byDifficulty[diff] = { total: 0, passed: 0, passRate: 0 }
      byDifficulty[diff]!.total++
      if (result.status === 'pass') byDifficulty[diff]!.passed++
    }
    for (const k of Object.keys(byDifficulty)) {
      const d = byDifficulty[k]!
      d.passRate = d.total > 0 ? d.passed / d.total : 0
    }

    return {
      total,
      passed,
      failed,
      errored,
      timedOut,
      passRate: total > 0 ? passed / total : 0,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      byDifficulty,
    }
  }
}
