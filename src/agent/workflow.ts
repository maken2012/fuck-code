// src/agent/workflow.ts
// 工作流层：从需求到开发测试的完整流程编排。
// /workflow <需求> 会自动走四个阶段，每阶段独立 queryLoop，阶段间汇报进度。
//
// 这是 fuckcode 的核心差异化：不只是问答，而是"接到需求 → 理解 → 实现 → 验证 → 交付"的闭环。
//
// 四阶段：
// 1. understand（理解）：plan 模式分析需求，产出实施计划 + 任务拆解
// 2. implement（实现）：按计划改代码（acceptEdits，可写）
// 3. verify（验证）：跑测试 / lint / 构建，确认改动正确
// 4. summarize（回顾）：汇报改了什么、结果如何、遗留问题
import { queryLoop } from '@/agent/queryLoop.js'
import { buildSystemPrompt } from '@/agent/systemPrompt.js'
import { PLAN_MODE_INSTRUCTION } from '@/agent/planPrompt.js'
import { getAllTools } from '@/tools/registry.js'
import type { QueryEvent } from '@/agent/types.js'
import type { PermissionMode } from '@/permissions/modes.js'

export type WorkflowStage = 'understand' | 'implement' | 'verify' | 'summarize'

export interface WorkflowStageStart {
  type: 'workflow_stage_start'
  stage: WorkflowStage
  description: string
}
export interface WorkflowStageEnd {
  type: 'workflow_stage_end'
  stage: WorkflowStage
  output: string
}
export type WorkflowEvent =
  | WorkflowStageStart
  | WorkflowStageEnd
  | { type: 'workflow_text'; stage: WorkflowStage; textDelta: string }
  | { type: 'workflow_tool'; stage: WorkflowStage; tool: string; summary: string }
  | { type: 'workflow_done'; summary: string }
  | { type: 'workflow_aborted'; completedStages: WorkflowStage[] }
  | { type: 'workflow_error'; stage: WorkflowStage; error: string }

export interface WorkflowOpts {
  requirement: string
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
  /** 测试用：注入 mock queryLoop */
  _queryLoopOverride?: (opts: object) => AsyncGenerator<QueryEvent>
}

const STAGES: { stage: WorkflowStage; description: string }[] = [
  { stage: 'understand', description: '理解需求并产出实施计划' },
  { stage: 'implement', description: '按计划实现代码改动' },
  { stage: 'verify', description: '运行测试与 lint 验证' },
  { stage: 'summarize', description: '汇报改动与结果' },
]

// 每阶段的 system prompt 增强指令
const STAGE_INSTRUCTIONS: Record<WorkflowStage, string> = {
  understand: `
# 当前阶段：理解（UNDERSTAND）
你现在处于工作流的第一阶段。任务：
1. 充分理解用户的需求（用自己的话复述，有歧义就指出）
2. 用 Read/Glob/Grep 调研相关代码
3. 产出一份清晰的实施计划（步骤 + 每步要改的文件）
4. 列出验证标准（每步完成的判断依据）

这是只读阶段，不要修改任何文件。你的计划会被后续阶段执行。`,

  implement: `
# 当前阶段：实现（IMPLEMENT）
你现在处于工作流的第二阶段。你会收到上一阶段的实施计划。

任务：
1. 严格按照计划逐步实现
2. 每改一个文件前先 Read，改完确认无误
3. 不要超出计划范围做"顺手优化"
4. 改动遵循 AGENTS.md 和现有代码风格
5. 记录你实际做了什么（供下阶段验证）

如果计划有不可行的地方，停下来说明原因，不要硬来。`,

  verify: `
# 当前阶段：验证（VERIFY）
你现在处于工作流的第三阶段。代码改动已完成。

任务：
1. 用 Bash 工具运行项目的测试命令（参考 AGENTS.md 或 package.json）
2. 如果测试失败，分析原因并尝试修复（回到 implement 模式）
3. 运行 lint / typecheck（如有）
4. 给出验证结论：通过 / 失败 / 部分通过

诚实汇报结果，不要谎报"测试通过"。`,

  summarize: `
# 当前阶段：回顾（SUMMARIZE）
你现在处于工作流的最后阶段。

任务：产出一分简洁的交付汇报，包含：
1. **改了什么**：列出新修改/创建的文件（file_path + 一句话说明）
2. **验证结果**：测试/lint 是否通过
3. **遗留问题**：未完成的部分、需要注意的边界、后续建议
4. **下一步**：用户应该做什么（如 review 代码、手动验证某场景）

用 markdown 格式，简洁直接。`,
}

export async function* runWorkflow(opts: WorkflowOpts): AsyncGenerator<WorkflowEvent> {
  const queryLoopFn = opts._queryLoopOverride ?? (queryLoop as unknown as (o: object) => AsyncGenerator<QueryEvent>)
  const completedStages: WorkflowStage[] = []
  let accumulatedContext = '' // 跨阶段传递（计划传给实现，实现传给验证...）

  for (const { stage, description } of STAGES) {
    if (opts.signal.aborted) {
      yield { type: 'workflow_aborted', completedStages }
      return
    }

    yield { type: 'workflow_stage_start', stage, description }

    // 每阶段的 system prompt = 基础 + 阶段指令（understand 阶段加 PLAN 指令）
    const baseSystem = await buildSystemPrompt({ tools: getAllTools() })
    let stageSystem = baseSystem + STAGE_INSTRUCTIONS[stage]
    if (stage === 'understand') stageSystem += PLAN_MODE_INSTRUCTION

    // 每阶段的 user prompt：原需求 + 之前阶段的输出（上下文传递）
    const stagePrompts: string[] = [`## 原始需求\n${opts.requirement}`]
    if (accumulatedContext) {
      stagePrompts.push(`## 上一阶段的产出\n${accumulatedContext}`)
    }
    const stageUserInput =
      stage === 'understand'
        ? opts.requirement
        : stagePrompts.join('\n\n---\n\n')

    // 每阶段的权限模式
    const stagePermission: PermissionMode =
      stage === 'understand' ? 'plan' : stage === 'summarize' ? 'plan' : 'acceptEdits'

    // 每阶段的工具：understand/summarize 用全部（但 plan 模式禁止写）；
    // implement/verify 用全部
    const stageTools = getAllTools()

    let stageOutput = ''

    try {
      for await (const event of queryLoopFn({
        history: [], // 每阶段独立上下文，靠 accumulatedContext 传递
        userInput: stageUserInput,
        model: opts.model,
        system: stageSystem,
        maxTokens: opts.config.maxTokens,
        signal: opts.signal,
        apiKey: opts.apiKey,
        ...(opts.apiBaseUrl ? { apiBaseUrl: opts.apiBaseUrl } : {}),
        cwd: opts.cwd,
        tools: stageTools,
        permissionMode: stagePermission,
        permissions: opts.config.permissions,
        contextWindow: opts.config.contextWindow,
      })) {
        switch (event.type) {
          case 'text_delta':
            stageOutput += event.text
            yield { type: 'workflow_text', stage, textDelta: event.text }
            break
          case 'tool_use_start': {
            const i = (event.input ?? {}) as Record<string, unknown>
            const summary =
              event.tool === 'Bash' ? String(i.command ?? '').slice(0, 60) :
              ['Read', 'Edit', 'Write'].includes(event.tool) ? String(i.file_path ?? '') :
              ['Grep', 'Glob'].includes(event.tool) ? String(i.pattern ?? '') :
              JSON.stringify(event.input).slice(0, 60)
            yield { type: 'workflow_tool', stage, tool: event.tool, summary }
            break
          }
          case 'turn_end':
          case 'done':
            break
          case 'error':
            // 深度比对第 31 轮: 阶段失败不终止整个 workflow——记录错误，继续下一阶段
            yield { type: 'workflow_error', stage, error: event.error.message }
            stageOutput += `\n\n[本阶段出错: ${event.error.message}]`
            break // 不 return——继续到 stage_end
          case 'aborted':
            yield { type: 'workflow_aborted', completedStages }
            return
        }
      }
    } catch (e) {
      // 深度比对第 31 轮: 阶段异常不终止——记录错误继续
      stageOutput += `\n\n[本阶段异常: ${String(e)}]`
    }

    // 深度比对第 31 轮: 上下文截断（防后阶段 prompt 过长）
    const MAX_CONTEXT = 8000
    accumulatedContext += `\n\n### ${stage} 阶段输出\n${stageOutput}`
    if (accumulatedContext.length > MAX_CONTEXT) {
      accumulatedContext = accumulatedContext.slice(-MAX_CONTEXT)
    }
    completedStages.push(stage)
    yield { type: 'workflow_stage_end', stage, output: stageOutput }
  }

  yield { type: 'workflow_done', summary: accumulatedContext }
}
