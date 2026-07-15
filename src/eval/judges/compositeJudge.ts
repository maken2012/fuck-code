// src/eval/judges/compositeJudge.ts
// composite 判定器：组合多个 judge。
//
// - requireAll=true（默认）：全部通过才算 pass
// - requireAll=false：任一通过即 pass
//
// 典型用法：多轮任务最后一轮既要 test 通过，又要文件存在 → composite([test, behavior])
import type { Judge, JudgeContext } from '@/eval/judges/types.js'
import type { JudgeResult } from '@/eval/types.js'

export class CompositeJudge implements Judge {
  constructor(
    private readonly judges: Judge[],
    private readonly requireAll: boolean = true,
  ) {}

  async judge(ctx: JudgeContext): Promise<JudgeResult> {
    const results = await Promise.all(this.judges.map((j) => j.judge(ctx)))

    if (this.requireAll) {
      // 全部通过才算 pass
      const allPassed = results.every((r) => r.pass)
      const passedCount = results.filter((r) => r.pass).length
      const avgScore = results.reduce((sum, r) => sum + (r.score ?? 0), 0) / results.length

      return {
        pass: allPassed,
        score: avgScore,
        reason: allPassed
          ? `全部 ${results.length} 项判定通过`
          : `${passedCount}/${results.length} 项通过：\n${results.filter((r) => !r.pass).map((r) => `  ✗ ${r.reason}`).join('\n')}`,
        details: results.map((r, i) => ({ judgeIndex: i, pass: r.pass, reason: r.reason })),
      }
    }

    // 任一通过即 pass
    const anyPassed = results.some((r) => r.pass)
    const bestScore = Math.max(...results.map((r) => r.score ?? 0))
    return {
      pass: anyPassed,
      score: bestScore,
      reason: anyPassed
        ? `至少 1 项判定通过`
        : `全部 ${results.length} 项判定失败：\n${results.map((r) => `  ✗ ${r.reason}`).join('\n')}`,
      details: results.map((r, i) => ({ judgeIndex: i, pass: r.pass, reason: r.reason })),
    }
  }
}
