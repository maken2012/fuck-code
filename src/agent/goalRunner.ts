// src/agent/goalRunner.ts
// /goal 命令的核心：目标驱动的跨轮次持续工作。
// 照 Claude Code /goal 思路：设一个完成条件，Claude 反复"做事→检查→继续"直到条件满足。
//
// 实现：
// 1. 用户设 goal（如"测试全过"）
// 2. 循环：跑一轮 queryLoop（让模型工作）→ 检查 goal 是否达成（用 LLM 判定）→ 未达成继续
// 3. 达成 / 超过最大轮次 / 用户中断 时停止
//
// goal 检查：用一个小型 LLM 调用，问"根据以下工作记录，目标 X 是否已达成？只回答 YES 或 NO"
import { queryLoop } from '@/agent/queryLoop.js'
import { buildSystemPrompt } from '@/agent/systemPrompt.js'
import { getAllTools } from '@/tools/registry.js'
import type { QueryEvent } from '@/agent/types.js'
import type { LlmEvent } from '@/llm/types.js'
import { streamMessage } from '@/llm/provider.js'

export interface GoalOpts {
  goal: string                  // 完成条件（如"所有测试通过"）
  model: string
  apiKey?: string
  apiBaseUrl?: string
  signal: AbortSignal
  cwd: string
  config: {
    maxTokens: number
    contextWindow: number
    permissions: { allow: string[]; ask: string[]; deny: string[] }
  }
  sessionId?: string
  /** 最大工作轮次（防无限循环），默认 10 */
  maxTurns?: number
  /** 测试用 */
  _queryLoopOverride?: (opts: object) => AsyncGenerator<QueryEvent>
  _checkOverride?: (goal: string, workLog: string) => Promise<boolean>
}

export type GoalEvent =
  | { type: 'goal_start'; goal: string; maxTurns: number }
  | { type: 'goal_turn_start'; turn: number }
  | { type: 'goal_work'; text: string }            // 工作中的文本片段
  | { type: 'goal_tool'; tool: string; summary: string }
  | { type: 'goal_turn_end'; turn: number }
  | { type: 'goal_checking'; turn: number }
  | { type: 'goal_achieved'; turn: number; totalWork: string }
  | { type: 'goal_max_turns'; turns: number }
  | { type: 'goal_aborted'; turns: number }
  | { type: 'goal_error'; error: string }

const GOAL_CHECK_PROMPT = `你是一个目标达成检查器。用户设定了一个目标，agent 已经做了一些工作。
根据工作记录判断：目标是否已经达成？

判断标准：
- 目标是"${'__GOAL__'}"
- 只看工作记录里的实际行动和结果
- 如果目标明确达成（如测试通过、文件已创建），回答 YES
- 如果还没达成或不确定，回答 NO
- 只回答一个词：YES 或 NO`

// 用 LLM 检查 goal 是否达成
async function checkGoalAchieved(
  goal: string,
  workLog: string,
  opts: { model: string; apiKey?: string; apiBaseUrl?: string; signal: AbortSignal },
): Promise<boolean> {
  const prompt = GOAL_CHECK_PROMPT.replace('__GOAL__', goal)
  let answer = ''
  try {
    for await (const event of streamMessage({
      model: opts.model,
      system: '你是一个目标达成检查器，只回答 YES 或 NO。',
      messages: [{ role: 'user', content: `${prompt}\n\n--- 工作记录 ---\n${workLog.slice(-3000)}` }],
      maxTokens: 10,
      signal: opts.signal,
      apiKey: opts.apiKey,
      ...(opts.apiBaseUrl ? { apiBaseUrl: opts.apiBaseUrl } : {}),
    })) {
      if (event.type === 'text') answer += (event as LlmEvent & { textDelta: string }).textDelta
    }
  } catch {
    return false
  }
  return answer.trim().toUpperCase().includes('YES')
}

export async function* runGoal(opts: GoalOpts): AsyncGenerator<GoalEvent> {
  const maxTurns = opts.maxTurns ?? 10
  const queryLoopFn = opts._queryLoopOverride ?? (queryLoop as unknown as (o: object) => AsyncGenerator<QueryEvent>)
  const checkFn = opts._checkOverride ?? checkGoalAchieved

  let workLog = ''

  yield { type: 'goal_start', goal: opts.goal, maxTurns }

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (opts.signal.aborted) {
      yield { type: 'goal_aborted', turns: turn - 1 }
      return
    }

    yield { type: 'goal_turn_start', turn }

    // 每轮的工作 prompt：第一轮明确目标，后续轮提醒"继续往目标努力"
    const workPrompt = turn === 1
      ? `目标：${opts.goal}\n\n请开始工作达成这个目标。先分析需要做什么，然后用工具执行。`
      : `目标还没达成：${opts.goal}\n\n之前的工作：\n${workLog.slice(-1500)}\n\n继续努力达成目标。如果卡住了，换个思路。`

    let turnWork = ''
    let wasAborted = false
    const system = await buildSystemPrompt({ tools: getAllTools(), userQuery: opts.goal })

    try {
      for await (const event of queryLoopFn({
        history: [],
        userInput: workPrompt,
        model: opts.model,
        system,
        maxTokens: opts.config.maxTokens,
        signal: opts.signal,
        apiKey: opts.apiKey,
        ...(opts.apiBaseUrl ? { apiBaseUrl: opts.apiBaseUrl } : {}),
        cwd: opts.cwd,
        tools: getAllTools(),
        permissionMode: 'acceptEdits',
        permissions: opts.config.permissions,
        sessionId: opts.sessionId,
        contextWindow: opts.config.contextWindow,
      })) {
        if (event.type === 'text_delta') {
          turnWork += event.text
          yield { type: 'goal_work', text: event.text }
        } else if (event.type === 'aborted') {
          wasAborted = true
        } else if (event.type === 'tool_use_start') {
          const i = (event.input ?? {}) as Record<string, unknown>
          const summary = ['Bash'].includes(event.tool) ? String(i.command ?? '').slice(0, 60) :
            ['Read', 'Edit', 'Write'].includes(event.tool) ? String(i.file_path ?? '') :
            ['Grep', 'Glob'].includes(event.tool) ? String(i.pattern ?? '') : ''
          yield { type: 'goal_tool', tool: event.tool, summary }
        }
      }
    } catch (e) {
      if (opts.signal.aborted) {
        yield { type: 'goal_aborted', turns: turn - 1 }
        return
      }
      yield { type: 'goal_error', error: String(e) }
      return
    }

    workLog += `\n\n### 第 ${turn} 轮\n${turnWork}`
    yield { type: 'goal_turn_end', turn }

    if (wasAborted || opts.signal.aborted) {
      yield { type: 'goal_aborted', turns: turn }
      return
    }

    // 检查 goal 是否达成
    yield { type: 'goal_checking', turn }
    const achieved = await checkFn(opts.goal, workLog, {
      model: opts.model,
      apiKey: opts.apiKey,
      apiBaseUrl: opts.apiBaseUrl,
      signal: opts.signal,
    }).catch(() => false)

    if (achieved) {
      yield { type: 'goal_achieved', turn, totalWork: workLog }
      return
    }
  }

  yield { type: 'goal_max_turns', turns: maxTurns }
}
