// src/eval/judges/behaviorJudge.ts
// behavior 判定器：检查文件状态或跑命令的行为断言。
// 适合没有标准测试套件的任务（如"创建一个 CLI 工具文件"）。
//
// 5 种断言：
// - file-exists：文件存在
// - file-not-exists：文件不存在
// - file-contains：文件内容匹配正则
// - file-not-contains：文件内容不匹配正则
// - command-exits-zero：跑命令 exit 0
//
// 全部断言通过才算 pass（AND 逻辑）。
import type { Judge, JudgeContext } from '@/eval/judges/types.js'
import type { JudgeResult, BehaviorAssertion } from '@/eval/types.js'
import { runCommand, readFileRaw, fileExists } from '@/eval/isolation.js'
import { join } from 'node:path'

interface AssertionResult {
  assertion: BehaviorAssertion
  passed: boolean
  detail: string
}

export class BehaviorJudge implements Judge {
  constructor(private readonly assertions: BehaviorAssertion[]) {}

  async judge(ctx: JudgeContext): Promise<JudgeResult> {
    const results: AssertionResult[] = []

    for (const assertion of this.assertions) {
      const result = await this.checkAssertion(assertion, ctx.workspaceDir)
      results.push(result)
    }

    const allPassed = results.every((r) => r.passed)
    const passedCount = results.filter((r) => r.passed).length

    if (allPassed) {
      return {
        pass: true,
        score: 1,
        reason: `全部 ${results.length} 条断言通过`,
        details: results.map((r) => ({ assertion: r.assertion, passed: r.passed, detail: r.detail })),
      }
    }

    const failed = results.filter((r) => !r.passed)
    return {
      pass: false,
      score: passedCount / results.length,
      reason: `${failed.length}/${results.length} 条断言失败：\n${failed.map((r) => `  ✗ ${this.describeAssertion(r.assertion)}: ${r.detail}`).join('\n')}`,
      details: results.map((r) => ({ assertion: r.assertion, passed: r.passed, detail: r.detail })),
    }
  }

  private async checkAssertion(assertion: BehaviorAssertion, workspaceDir: string): Promise<AssertionResult> {
    switch (assertion.kind) {
      case 'file-exists': {
        const absPath = join(workspaceDir, assertion.path)
        const exists = await fileExists(absPath)
        return {
          assertion,
          passed: exists,
          detail: exists ? '文件存在' : `文件不存在: ${assertion.path}`,
        }
      }
      case 'file-not-exists': {
        const absPath = join(workspaceDir, assertion.path)
        const exists = await fileExists(absPath)
        return {
          assertion,
          passed: !exists,
          detail: !exists ? '文件不存在（符合预期）' : `文件仍存在: ${assertion.path}`,
        }
      }
      case 'file-contains': {
        const absPath = join(workspaceDir, assertion.path)
        const exists = await fileExists(absPath)
        if (!exists) return { assertion, passed: false, detail: `文件不存在: ${assertion.path}` }
        const content = await readFileRaw(absPath).catch(() => '')
        const re = safeRegex(assertion.pattern)
        const matched = re ? re.test(content) : content.includes(assertion.pattern)
        return {
          assertion,
          passed: matched,
          detail: matched ? '匹配成功' : `内容未匹配 /${assertion.pattern}/`,
        }
      }
      case 'file-not-contains': {
        const absPath = join(workspaceDir, assertion.path)
        const exists = await fileExists(absPath)
        if (!exists) return { assertion, passed: true, detail: '文件不存在（视为不包含，符合预期）' }
        const content = await readFileRaw(absPath).catch(() => '')
        const re = safeRegex(assertion.pattern)
        const matched = re ? re.test(content) : content.includes(assertion.pattern)
        return {
          assertion,
          passed: !matched,
          detail: !matched ? '未匹配（符合预期）' : `内容匹配了不该出现的 /${assertion.pattern}/`,
        }
      }
      case 'command-exits-zero': {
        const result = await runCommand(assertion.command, workspaceDir, assertion.timeoutMs ?? 30000)
        return {
          assertion,
          passed: result.ok,
          detail: result.ok ? '命令 exit 0' : `命令 exit ${result.exitCode}${result.timedOut ? '（超时）' : ''}`,
        }
      }
    }
  }

  private describeAssertion(a: BehaviorAssertion): string {
    switch (a.kind) {
      case 'file-exists': return `file-exists(${a.path})`
      case 'file-not-exists': return `file-not-exists(${a.path})`
      case 'file-contains': return `file-contains(${a.path}, /${a.pattern}/)`
      case 'file-not-contains': return `file-not-contains(${a.path}, /${a.pattern}/)`
      case 'command-exits-zero': return `command-exits-zero(${a.command})`
    }
  }
}

/** 安全编译正则，失败返回 null（退化为字符串匹配） */
function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}
