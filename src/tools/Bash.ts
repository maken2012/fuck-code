// src/tools/Bash.ts
// 用 spawn 执行 shell 命令。
//
// 设计：
// - spawn(command, { shell: true, detached: true })，在 ctx.cwd 下执行
// - timeout 默认 120000ms；超时 kill 进程组（避免孤儿）
// - run_in_background=true：spawn 后立即返回 pid（不等待）
// - 输出截断：stdout/stderr 各最多 MAX_OUTPUT_CHARS（30000）字符，超限标记 truncated
// - 非零退出码与超时均视为失败（ok=false）
//
// isReadOnly: false，isConcurrencySafe: false。
import { spawn, type ChildProcess } from 'node:child_process'
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'

const MAX_OUTPUT_CHARS = 30000
const DEFAULT_TIMEOUT = 120000

const BashInput = z.object({
  command: z.string().describe('要执行的 shell 命令'),
  timeout: z.number().int().positive().describe(`超时毫秒（默认 ${DEFAULT_TIMEOUT}）`).optional(),
  run_in_background: z.boolean().describe('后台运行，立即返回 pid').optional(),
})
type BashInputType = z.infer<typeof BashInput>

export interface BashResultData {
  stdout: string
  stderr: string
  exitCode: number | null
  truncated: boolean
}

// 运行结果（runChild 收集用）：区分正常结束 / 超时 / spawn 失败
type RunOutcome =
  | { kind: 'done'; exitCode: number | null; stdout: string; stderr: string; truncated: boolean }
  | { kind: 'timeout' }
  | { kind: 'spawn_error'; message: string }

export const BashTool = buildTool<BashInputType>({
  name: 'Bash',
  description: '执行 shell 命令',
  prompt: `执行 shell 命令（用 spawn + { shell: true }）。

参数：
- command（必填）：shell 命令字符串
- timeout（可选）：超时毫秒，默认 ${DEFAULT_TIMEOUT}（超时会 kill 进程组）
- run_in_background（可选）：true 时立即返回 pid，不等待命令结束

输出（stdout + stderr）各自最多保留 ${MAX_OUTPUT_CHARS} 字符，超限会被截断并标记 truncated。
命令非零退出码与超时均视为失败。`,
  inputSchema: BashInput,
  jsonSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
      timeout: {
        type: 'integer',
        minimum: 1,
        description: `超时毫秒（默认 ${DEFAULT_TIMEOUT}）`,
      },
      run_in_background: { type: 'boolean', description: '后台运行，立即返回 pid' },
    },
    required: ['command'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  async execute(input, ctx) {
    const { command } = input
    const timeout = input.timeout ?? DEFAULT_TIMEOUT
    const background = input.run_in_background === true

    let child: ChildProcess
    try {
      child = spawn(command, {
        shell: true,
        cwd: ctx.cwd,
        // 独立进程组，超时时 kill 整组（避免孤儿子进程）
        detached: true,
      })
    } catch (e) {
      return { ok: false, error: `Bash 启动失败: ${(e as Error).message}`, isError: true }
    }

    // 后台：立即返回 pid，不等待
    if (background) {
      child.unref()
      return {
        ok: true,
        data: { pid: child.pid, background: true },
      }
    }

    // 前台：收集输出 + 超时控制
    const outcome = await runChild(child, timeout)
    if (outcome.kind === 'spawn_error') {
      return { ok: false, error: `Bash 执行失败: ${outcome.message}`, isError: true }
    }
    if (outcome.kind === 'timeout') {
      return {
        ok: false,
        error: `命令超时（${timeout}ms）被终止: ${command}`,
        isError: true,
      }
    }
    // done
    if (outcome.exitCode !== 0 && outcome.exitCode !== null) {
      return {
        ok: false,
        error: `命令退出码 ${outcome.exitCode}${outcome.stderr ? `: ${outcome.stderr.slice(0, 500)}` : ''}`,
        isError: true,
      }
    }
    return { ok: true, data: outcomeToData(outcome) }
  },
})

// 收集 stdout/stderr（边收边截断），超时 kill 进程组
function runChild(child: ChildProcess, timeout: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let settled = false

    const settle = (o: RunOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(o)
    }

    if (child.stdout) {
      child.stdout.on('data', (d: Buffer) => {
        if (stdoutTruncated) return
        stdout += d.toString()
        if (stdout.length > MAX_OUTPUT_CHARS) {
          stdout = stdout.slice(0, MAX_OUTPUT_CHARS)
          stdoutTruncated = true
        }
      })
    }
    if (child.stderr) {
      child.stderr.on('data', (d: Buffer) => {
        if (stderrTruncated) return
        stderr += d.toString()
        if (stderr.length > MAX_OUTPUT_CHARS) {
          stderr = stderr.slice(0, MAX_OUTPUT_CHARS)
          stderrTruncated = true
        }
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      // kill 整个进程组（detached 时 child.pid = pgid）
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 进程可能已退出 */
        }
      }
    }, timeout)

    child.on('error', (e) => {
      if (timedOut) return // 超时导致的 kill 会先在 close 处理
      settle({ kind: 'spawn_error', message: e.message })
    })

    child.on('close', (code) => {
      if (timedOut) {
        settle({ kind: 'timeout' })
        return
      }
      settle({
        kind: 'done',
        exitCode: code,
        stdout,
        stderr,
        truncated: stdoutTruncated || stderrTruncated,
      })
    })
  })
}

function outcomeToData(o: Extract<RunOutcome, { kind: 'done' }>): BashResultData {
  return {
    stdout: o.stdout,
    stderr: o.stderr,
    exitCode: o.exitCode,
    truncated: o.truncated,
  }
}
