// src/eval/driver.ts
// EvalDriver：评测核心驱动器。
//
// 职责：拿一个 EvalTask + 隔离工作区，跑完所有轮次，收集每轮的事件数据，
// 返回 TaskRunResult（不含判定，判定交给 Judge）。
//
// 多轮累积机制：复用 queryLoop 的 sessionId。
// - 第 1 轮 createSession → 拿到 sessionId
// - 第 2..N 轮传同一个 sessionId → queryLoop 内部 loadMessages 自动加载前几轮历史
// - 这样模型能看到之前轮次的产出（文件改动在同一个工作区，对话在同一个 session）
//
// 事件收集：每轮 queryLoop 是一个 async generator，driver for-await 消费：
// - text_delta → 拼到 turnResult.text
// - tool_use_start → push 到 turnResult.toolsCalled
// - usage → 累加 turnResult.tokens + totalTokens
// - turn_end → turnCount++（一次 queryLoop 调用可能有多个 turn_end，对应工具调用循环）
// - error/aborted → 设 error 状态
import type { EvalTask, TurnResult, TaskRunResult, TaskStatus, DriverOpts } from '@/eval/types.js'
import type { QueryEvent } from '@/agent/types.js'
import type { LlmEvent } from '@/llm/types.js'
import { queryLoop } from '@/agent/queryLoop.js'
import type { QueryLoopOpts } from '@/agent/queryLoop.js'
import { buildSystemPrompt } from '@/agent/systemPrompt.js'
import { getAllTools } from '@/tools/registry.js'
import { createSession } from '@/services/Session.js'
import { getConfig } from '@/services/runtime.js'
import { resolveLlmOverride } from '@/eval/recorder.js'
import { LLMClient } from '@/llm/LLMClient.js'

/**
 * EvalDriver：跑单个任务的所有轮次。
 *
 * 用法：
 *   const driver = new EvalDriver()
 *   const result = await driver.runTask(task, workspaceDir, opts)
 */
export class EvalDriver {
  /**
   * 跑一个任务的所有轮次。
   *
   * @param task 任务定义
   * @param workspaceDir 隔离工作区绝对路径
   * @param opts 驱动选项（模型/llmMode 等）
   * @returns 运行结果（status 可能是 pass/fail/error/timeout，但 driver 只产生 error/timeout；
   *          pass/fail 由 Judge 判定后由 runner 回填）
   */
  async runTask(
    task: EvalTask,
    workspaceDir: string,
    opts: DriverOpts,
    /** 测试用：注入 mock queryLoop（跳过真实 LLM/session/config） */
    _queryLoopOverride?: (opts: QueryLoopOpts) => AsyncGenerator<QueryEvent>,
  ): Promise<TaskRunResult> {
    const startedAt = Date.now()

    // 测试模式：有 override 时跳过所有真实初始化，直接用它
    if (_queryLoopOverride) {
      return this.runTaskWithMock(task, workspaceDir, opts, _queryLoopOverride, startedAt)
    }

    // 加载 config（apiKey/model 等可能来自 config）
    const config = await getConfig().catch(() => null)
    const model = opts.model ?? config?.value.model ?? 'claude-sonnet-4-5-20250929'
    const apiKey = opts.apiKey ?? config?.value.apiKey
    const apiBaseUrl = opts.apiBaseUrl ?? config?.value.apiBaseUrl
    const provider = opts.provider ?? config?.value.provider
    const maxTokens = config?.value.maxTokens ?? 8192
    const contextWindow = config?.value.contextWindow ?? 200000
    const timeoutMs = opts.timeoutMs ?? task.timeoutMs ?? 120000

    // eval 模式：启用 safe-mode 跳过 memory/skill/AGENTS.md/hooks（避免污染评测环境）
    process.env.FUCKCODE_SAFE_MODE = '1'

    // 构建 system prompt（传 cwdOverride 指向隔离工作区，否则模型会把文件写到进程 cwd）
    const system = await buildSystemPrompt({ tools: getAllTools(), cwdOverride: workspaceDir })

    // 创建 session（多轮累积的关键：同一个 sessionId）
    let sessionId: string | undefined
    try {
      sessionId = await createSession(workspaceDir)
    } catch {
      // 无 session 也能跑（退化成无持久化，但多轮累积会失效）
    }

    // 准备 LLM stream（live/record/replay）
    const llmClient = LLMClient.fromConfig({
      apiKey,
      apiBaseUrl,
      provider,
      fallbackModels: config?.value.fallbackModels,
    })
    const realStream = (streamOpts: object) =>
      llmClient.stream(streamOpts as Parameters<typeof llmClient.stream>[0])

    const modePath = opts.llmMode === 'record'
      ? opts.recordFile
      : opts.llmMode === 'replay'
        ? opts.replayFile
        : undefined
    const llmOverride = await resolveLlmOverride(opts.llmMode, realStream, modePath)

    // 跑每一轮
    const turnResults: TurnResult[] = []
    let totalTokens = { input: 0, output: 0, cacheRead: 0 }
    let taskError: string | undefined

    const ac = new AbortController()
    const timer = setTimeout(() => {
      ac.abort()
    }, timeoutMs)

    try {
      for (let i = 0; i < task.turns.length; i++) {
        const turn = task.turns[i]!
        const turnStart = Date.now()

        const queryOpts: QueryLoopOpts = {
          history: [], // 用 sessionId 时 history 被忽略，queryLoop 从 JSONL 加载
          userInput: turn.prompt,
          model,
          system,
          maxTokens,
          signal: ac.signal,
          apiKey,
          ...(apiBaseUrl ? { apiBaseUrl } : {}),
          ...(provider ? { provider } : {}),
          cwd: workspaceDir,
          tools: getAllTools(),
          permissionMode: 'bypassPermissions', // eval 沙箱内全放行
          permissions: { allow: [], ask: [], deny: [] },
          sessionId,
          contextWindow,
          ...(llmOverride ? { _llmOverride: llmOverride } : {}),
        }

        const turnResult = await this.collectTurnEvents(queryOpts, turn.prompt, turn.expectTools, ac)
        turnResult.durationMs = Date.now() - turnStart

        turnResults.push(turnResult)
        totalTokens.input += turnResult.tokens.input
        totalTokens.output += turnResult.tokens.output

        // 如果某轮出错，终止后续轮次
        if (turnResult.turnCount === 0 && !turnResult.text && turnResult.toolsCalled.length === 0) {
          taskError = `第 ${i + 1} 轮无任何输出（可能 LLM 调用失败）`
          break
        }
      }
    } catch (e) {
      taskError = e instanceof Error ? e.message : String(e)
    } finally {
      clearTimeout(timer)
    }

    const durationMs = Date.now() - startedAt

    // 判定状态：driver 只判定 error/timeout，pass/fail 留给 Judge
    let status: TaskStatus = 'fail' // 默认 fail，runner 用 Judge 结果覆盖
    if (taskError) {
      status = ac.signal.aborted ? 'timeout' : 'error'
    }

    return {
      taskId: task.id,
      taskName: task.name,
      difficulty: task.difficulty,
      status,
      turns: turnResults,
      judgeResult: { pass: false, reason: '尚未判定' }, // runner 会用 Judge 结果覆盖
      totalTokens,
      durationMs,
      workspaceDir,
      error: taskError,
    }
  }

  /**
   * 测试模式：用 mock queryLoop 跑任务，跳过所有真实初始化。
   * 复用 collectTurnEvents 的事件收集逻辑。
   */
  private async runTaskWithMock(
    task: EvalTask,
    workspaceDir: string,
    opts: DriverOpts,
    mockQueryLoop: (qopts: QueryLoopOpts) => AsyncGenerator<QueryEvent>,
    startedAt: number,
  ): Promise<TaskRunResult> {
    const turnResults: TurnResult[] = []
    let totalTokens = { input: 0, output: 0, cacheRead: 0 }
    let taskError: string | undefined
    const ac = new AbortController()
    const timeoutMs = opts.timeoutMs ?? task.timeoutMs ?? 120000
    const timer = setTimeout(() => ac.abort(), timeoutMs)

    try {
      for (let i = 0; i < task.turns.length; i++) {
        const turn = task.turns[i]!
        const turnStart = Date.now()

        const queryOpts = {
          history: [],
          userInput: turn.prompt,
          model: opts.model ?? 'mock',
          system: 'mock',
          signal: ac.signal,
          cwd: workspaceDir,
          sessionId: `mock-${task.id}-${i}`,
        } as QueryLoopOpts

        const turnResult = await this.collectTurnEvents(
          queryOpts, turn.prompt, turn.expectTools, ac, mockQueryLoop,
        )
        turnResult.durationMs = Date.now() - turnStart
        turnResults.push(turnResult)
        totalTokens.input += turnResult.tokens.input
        totalTokens.output += turnResult.tokens.output

        if (turnResult.turnCount === 0 && !turnResult.text && turnResult.toolsCalled.length === 0) {
          taskError = `第 ${i + 1} 轮无任何输出`
          break
        }
      }
    } catch (e) {
      taskError = e instanceof Error ? e.message : String(e)
    } finally {
      clearTimeout(timer)
    }

    return {
      taskId: task.id,
      taskName: task.name,
      difficulty: task.difficulty,
      status: taskError ? (ac.signal.aborted ? 'timeout' : 'error') : 'fail',
      turns: turnResults,
      judgeResult: { pass: false, reason: '尚未判定' },
      totalTokens,
      durationMs: Date.now() - startedAt,
      workspaceDir,
      error: taskError,
    }
  }

  /**
   * 消费一轮 queryLoop 的所有事件，收集数据。
   */
  private async collectTurnEvents(
    queryOpts: QueryLoopOpts,
    prompt: string,
    expectTools: string[] | undefined,
    ac: AbortController,
    /** 可注入的 queryLoop（测试用，生产用真实 queryLoop） */
    queryLoopFn: (opts: QueryLoopOpts) => AsyncGenerator<QueryEvent> = queryLoop,
  ): Promise<TurnResult> {
    let text = ''
    const toolsCalled: string[] = []
    let tokens = { input: 0, output: 0 }
    let turnCount = 0

    try {
      for await (const event of queryLoopFn(queryOpts) as AsyncGenerator<QueryEvent>) {
        switch (event.type) {
          case 'text_delta':
            text += event.text
            break
          case 'tool_use_start':
            toolsCalled.push(event.tool)
            break
          case 'usage':
            tokens.input += event.input
            tokens.output += event.output
            break
          case 'turn_end':
            turnCount++
            break
          case 'permission_request':
            // bypassPermissions 模式下不该触发，但兜底：自动 allow
            event.resolve('allow')
            break
          case 'error':
            // queryLoop 内部错误：记下来，继续（可能后续 turn 能恢复）
            if (!ac.signal.aborted) {
              text += `\n[queryLoop 错误: ${event.error.message}]`
            }
            break
          case 'aborted':
            break
          case 'compacted':
          case 'tool_progress':
          case 'tool_result':
          case 'thinking_delta':
          case 'done':
            // 这些事件不影响记账
            break
        }
      }
    } catch (e) {
      // queryLoop 抛异常（如 AbortError）：不在这里处理，外层 catch 记
      throw e
    }

    return {
      prompt,
      text,
      toolsCalled,
      expectTools,
      tokens,
      durationMs: 0, // 外层回填
      turnCount,
    }
  }
}
