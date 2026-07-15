// src/eval/judges/types.ts
// 判定器统一接口。
// 所有 judge 实现这个接口，runner 用工厂函数根据 JudgeSpec.type 选对应实现。
import type { EvalTask, TurnResult, JudgeSpec, JudgeResult } from '@/eval/types.js'

/** 判定器上下文：judge 执行时能拿到的所有信息 */
export interface JudgeContext {
  /** 隔离工作区目录（判定在这里执行命令/读文件） */
  workspaceDir: string
  /** 原始任务定义 */
  task: EvalTask
  /** 所有轮次的运行结果 */
  turnResults: TurnResult[]
  /** 最后一轮的模型文本输出（llm-judge 用） */
  finalText: string
}

/** 判定器接口 */
export interface Judge {
  /** 执行判定，返回结果（pass + reason + 可选 score/details） */
  judge(ctx: JudgeContext): Promise<JudgeResult>
}

/**
 * 根据判据规格创建判定器。
 * 工厂模式：runner 用这个把 JSON 里的 JudgeSpec 转成可执行的 Judge。
 *
 * @param spec 判定规格
 * @param extra 额外参数（llm-judge 需要 apiKey/model 等）
 */
export async function createJudge(
  spec: JudgeSpec,
  extra?: { apiKey?: string; apiBaseUrl?: string; provider?: string; defaultModel?: string },
): Promise<Judge> {
  switch (spec.type) {
    case 'test': {
      const { TestJudge } = await import('@/eval/judges/testJudge.js')
      return new TestJudge(spec.command, spec.timeoutMs ?? 60000)
    }
    case 'lint': {
      const { TestJudge } = await import('@/eval/judges/testJudge.js')
      // lint 是 test 的特化：默认跑 tsc --noEmit
      const cmd = spec.command ?? 'npx tsc --noEmit'
      return new TestJudge(cmd, spec.timeoutMs ?? 30000)
    }
    case 'behavior': {
      const { BehaviorJudge } = await import('@/eval/judges/behaviorJudge.js')
      return new BehaviorJudge(spec.assertions)
    }
    case 'llm-judge': {
      const { LlmJudge } = await import('@/eval/judges/llmJudge.js')
      return new LlmJudge(
        spec.rubric,
        {
          apiKey: extra?.apiKey,
          apiBaseUrl: extra?.apiBaseUrl,
          provider: extra?.provider as 'anthropic' | 'openai' | 'openai-compatible' | undefined,
          model: spec.model ?? extra?.defaultModel,
        },
      )
    }
    case 'multi-rubric': {
      const { MultiRubricJudge } = await import('@/eval/judges/multiRubricJudge.js')
      return new MultiRubricJudge(
        spec.dimensions,
        spec.passThreshold ?? 0.7,
        {
          apiKey: extra?.apiKey,
          apiBaseUrl: extra?.apiBaseUrl,
          provider: extra?.provider as 'anthropic' | 'openai' | 'openai-compatible' | undefined,
          model: spec.model ?? extra?.defaultModel,
        },
      )
    }
    case 'composite': {
      const { CompositeJudge } = await import('@/eval/judges/compositeJudge.js')
      const subJudges = await Promise.all(spec.judges.map((s) => createJudge(s, extra)))
      return new CompositeJudge(subJudges, spec.requireAll ?? true)
    }
  }
}
