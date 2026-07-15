// src/eval/judges/testJudge.ts
// test 判定器：在隔离工作区跑命令，exit 0 = pass。
// 这是最可靠的判定方式（对标 SWE-bench 的 FAIL_TO_PASS、Aider 的 Exercism suite）。
//
// lint 判定器复用这个类（只是默认命令是 npx tsc --noEmit）。
import type { Judge, JudgeContext } from '@/eval/judges/types.js'
import type { JudgeResult } from '@/eval/types.js'
import { runCommand } from '@/eval/isolation.js'

/**
 * TestJudge：跑命令判定。
 *
 * @param command 要执行的命令（在 workspaceDir 下）
 * @param timeoutMs 超时毫秒
 */
export class TestJudge implements Judge {
  constructor(
    private readonly command: string,
    private readonly timeoutMs: number = 60000,
  ) {}

  async judge(ctx: JudgeContext): Promise<JudgeResult> {
    const result = await runCommand(this.command, ctx.workspaceDir, this.timeoutMs)

    if (result.timedOut) {
      return {
        pass: false,
        score: 0,
        reason: `命令超时（>${this.timeoutMs}ms）：${this.command}`,
        details: { stdout: truncate(result.stdout, 1000), stderr: truncate(result.stderr, 1000) },
      }
    }

    if (result.ok) {
      return {
        pass: true,
        score: 1,
        reason: `命令成功退出（exit 0）：${this.command}`,
        details: { stdout: truncate(result.stdout, 2000) },
      }
    }

    // 失败：截取输出帮助诊断
    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    return {
      pass: false,
      score: 0,
      reason: `命令退出码 ${result.exitCode}：${this.command}\n${truncate(combined, 2000)}`,
      details: {
        exitCode: result.exitCode,
        stdout: truncate(result.stdout, 3000),
        stderr: truncate(result.stderr, 3000),
      },
    }
  }
}

/** 截断字符串，超长加省略号标记 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n...（已截断，共 ${s.length} 字符）`
}
