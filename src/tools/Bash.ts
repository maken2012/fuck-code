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
  lineCount: number
  durationMs: number
  outputFile?: string
}

// 运行结果（runChild 收集用）：区分正常结束 / 超时 / spawn 失败
type RunOutcome =
  | { kind: 'done'; exitCode: number | null; stdout: string; stderr: string; truncated: boolean; lineCount: number; durationMs: number; outputFile?: string }
  | { kind: 'timeout'; stdout: string; stderr: string; lineCount: number; durationMs: number; outputFile?: string }
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

    // 深度比对第 11 轮: 危险命令检测（对标 Claude Code catastrophic removal）
    const dangerCheck = checkDangerousCommand(command)
    if (dangerCheck) {
      return {
        ok: false,
        error: `[REFUSED] 危险命令被拒绝: ${dangerCheck}\n如果确实需要执行，请在 config.json 的 permissions.deny 里移除对应规则，或用 --dangerously-skip-permissions 模式。`,
        isError: true,
      }
    }

    // 深度比对第 59 轮: sandbox.credentials 防护（对标 Claude Code sandbox.credentials）
    // 阻止读取凭证文件（.env/.ssh/.aws/.gnupg）
    const CREDENTIAL_PATHS = ['.env', '.ssh/', '.aws/', '.gnupg/', '.npmrc', '.pypirc', '.docker/']
    if (CREDENTIAL_PATHS.some((p) => command.includes(p))) {
      return {
        ok: false,
        error: `[REFUSED] 命令访问凭证文件（.env/.ssh/.aws 等），被 sandbox.credentials 阻止。`,
        isError: true,
      }
    }

    let child: ChildProcess
    try {
      // 深度比对第 36 轮: 固定 shell 为 bash（对标 Claude Code exec(cmd, signal, 'bash')）
      // 避免 zsh/.zshrc 别名和函数污染命令行为（跨平台一致性）
      child = spawn(command, {
        shell: '/bin/bash',  // macOS 自带 bash，Linux 通常也有
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

    // 前台：收集输出 + 超时控制 + 进度回调（深度比对第 44 轮）
    const cmdStartTime = Date.now()
    let progressStdout = ''
    let progressTimer: ReturnType<typeof setInterval> | null = null
    if (ctx.onProgress) {
      // 每 2s 推最近 3 行输出（对标 Claude Code BashTool onProgress 2s 间隔）
      child.stdout?.on('data', (d: Buffer) => { progressStdout += d.toString() })
      progressTimer = setInterval(() => {
        const lines = progressStdout.split('\n').filter(Boolean)
        ctx.onProgress?.({
          lines: lines.slice(-3),
          totalLines: lines.length,
          elapsedMs: Date.now() - cmdStartTime,
        })
      }, 2000)
    }
    const outcome = await runChild(child, timeout)
    if (progressTimer) clearInterval(progressTimer)
    if (outcome.kind === 'spawn_error') {
      return { ok: false, error: `Bash 执行失败: ${outcome.message}`, isError: true }
    }
    if (outcome.kind === 'timeout') {
      // 深度比对修复 #2：超时返回部分输出而非全丢
      const dur = `${(outcome.durationMs / 1000).toFixed(1)}s`
      const partial = outcome.stdout
        ? `\n\n部分输出（${outcome.lineCount} 行，${dur}）:\n${outcome.stdout.slice(0, 5000)}`
        : '\n\n（超时前无输出）'
      const fileHint = outcome.outputFile
        ? `\n\n完整输出已保存: ${outcome.outputFile}（可用 Read 工具读取）`
        : ''
      return {
        ok: false,
        error: `命令超时（${dur}）被终止: ${command}${partial}${fileHint}`,
        isError: true,
      }
    }
    // done
    if (outcome.exitCode !== 0 && outcome.exitCode !== null) {
      // 语义豁免：某些命令 exit 1 不是错误
      const cmd = input.command.trim()
      const firstWord = cmd.split(/\s+/)[0] ?? ''
      const isGitDiff = /^(git|diff)\b/.test(cmd)
      const isGrep = /^(grep|rg|ag)\b/.test(firstWord)
      const isTest = /\.(test|spec)\.|(test|vitest|jest)\b/.test(cmd)
      // 深度比对第 67 轮: 搜索/读取命令识别（对标 Claude Code isSearchOrReadBashCommand）
      const isSearchOrRead = /^(ls|cat|head|tail|wc|find|file|which|echo|rg|grep|ag|fd)\b/.test(firstWord)

      if (isGitDiff && outcome.exitCode === 1) {
        // git diff 有差异 exit 1 = 正常（有 diff 输出）
        return { ok: true, data: outcomeToData(outcome) || '(无差异)' }
      }
      if (isGrep && outcome.exitCode === 1) {
        // grep/rg 无匹配 exit 1 = 正常
        return { ok: true, data: '(无匹配)' }
      }
      if (isTest && outcome.exitCode !== 0) {
        // 测试失败 exit != 0：不是命令错误，是测试断言失败
        return {
          ok: false,
          error: `测试失败（exit ${outcome.exitCode}）:\n${(outcome.stdout ?? '').slice(0, 2000)}`,
          isError: true,
        }
      }
      return {
        ok: false,
        error: `命令退出码 ${outcome.exitCode}${outcome.stderr ? `: ${outcome.stderr.slice(0, 500)}` : ''}`,
        isError: true,
      }
    }
    // 深度比对第 67 轮: 搜索/读取命令语义识别——成功无输出时显示更友好的结果
    const data = outcomeToData(outcome)
    const cwdAfter = findCwdChange(data.stdout)
    if (cwdAfter && cwdAfter !== ctx.cwd && !cwdAfter.startsWith(ctx.cwd)) {
      data.stdout = (data.stdout || '') + `\n[!] 命令可能 cd 到了 ${cwdAfter}，后续命令仍在 ${ctx.cwd} 下执行`
    }
    return { ok: true, data }
  },

  // 深度比对修复 #8：截断时给模型明确标记（而非默默砍尾巴）
  formatResult(data: unknown): string {
    const d = data as BashResultData
    const dur = d.durationMs < 1000 ? `${d.durationMs}ms` : `${(d.durationMs / 1000).toFixed(1)}s`
    let result = `退出码: ${d.exitCode} · 耗时: ${dur} · ${d.lineCount} 行输出\n`
    if (d.stdout) result += `\nstdout:\n${d.stdout}`
    if (d.stderr) result += `\nstderr:\n${d.stderr}`
    if (d.truncated) {
      result += `\n\n[输出被截断——stdout/stderr 各保留 ${MAX_OUTPUT_CHARS} 字符。]`
      if (d.outputFile) result += `\n完整输出已保存: ${d.outputFile}（可用 Read 读取）`
    }
    // 深度比对第 62 轮: 静默命令识别（对标 Claude Code isSilentBashCommand）
    // mv/cp/rm/mkdir/touch/chmod/chown 等成功无输出 → 显示语义化结果
    if (!d.stdout && !d.stderr && d.exitCode === 0) {
      result = `[ OK ] 命令执行成功（${dur}，无输出）`
    }
    return result
  },
})

// 收集 stdout/stderr（边收边截断），超时 kill 进程组
function runChild(child: ChildProcess, timeout: number): Promise<RunOutcome> {
  const startTime = Date.now()
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let settled = false
    let lineCount = 0

    // 深度比对修复 #3：超时/截断时把完整输出落盘，让模型可二次读取
    const persistOutput = async (out: string, err: string): Promise<string | undefined> => {
      if (!out && !err) return undefined
      try {
        const { writeFile, mkdir } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const { tmpdir } = await import('node:os')
        const dir = join(tmpdir(), 'fuckcode-bash-output')
        await mkdir(dir, { recursive: true })
        const file = join(dir, `output-${Date.now()}-${child.pid ?? 0}.txt`)
        await writeFile(file, `stdout:\n${out}\n\nstderr:\n${err}`, 'utf8')
        return file
      } catch {
        return undefined
      }
    }

    const settle = (o: RunOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(o)
    }

    if (child.stdout) {
      child.stdout.on('data', (d: Buffer) => {
        if (stdoutTruncated) return
        const chunk = d.toString()
        stdout += chunk
        lineCount += chunk.split('\n').length - 1
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
      // 深度比对修复 #2：超时用 SIGTERM 优雅退出（而非 SIGKILL 全杀）
      // 进程有机会 flush 剩余输出，已收集的部分不丢
      try {
        child.kill('SIGTERM')
        // 3 秒后如果还活着才 SIGKILL
        setTimeout(() => {
          try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* 已退出 */ }
        }, 3000)
      } catch {
        /* 进程可能已退出 */
      }
    }, timeout)

    child.on('error', (e) => {
      if (timedOut) return // 超时导致的 kill 会先在 close 处理
      settle({ kind: 'spawn_error', message: e.message })
    })

    child.on('close', async (code) => {
      if (timedOut) {
        const outputFile = await persistOutput(stdout, stderr)
        settle({
          kind: 'timeout',
          stdout,
          stderr,
          lineCount,
          durationMs: Date.now() - startTime,
          outputFile,
        })
        return
      }
      const outputFile = (stdoutTruncated || stderrTruncated) ? await persistOutput(stdout, stderr) : undefined
      settle({
        kind: 'done',
        exitCode: code,
        stdout,
        stderr,
        truncated: stdoutTruncated || stderrTruncated,
        lineCount,
        durationMs: Date.now() - startTime,
        outputFile,
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
    lineCount: o.lineCount,
    durationMs: o.durationMs,
    outputFile: o.outputFile,
  }
}

// 深度比对第 11 轮: 危险命令检测（对标 Claude Code catastrophic removal）
// 检测可能导致不可逆数据损失的命令模式
function checkDangerousCommand(cmd: string): string | null {
  const c = cmd.toLowerCase()

  // rm -rf 根目录 / home
  if (/rm\s+(-rf|--force)[^|;&]*\s+(\/|~|\/home|\$home|\.\.\/\.\.\/)/i.test(c)) {
    return 'rm -rf 指向根目录或家目录（会导致不可逆删除）'
  }
  // rm -rf 带通配符到根
  if (/rm\s+(-rf|--force)[^|;&]*\s*\*/i.test(c) && /(^|\s)\*($|\s)/.test(c)) {
    return 'rm -rf 通配删除（可能误删大量文件）'
  }
  // curl/wget 管道到 sh/bash（远程代码执行）
  if (/(curl|wget)[^|]*\|\s*(sh|bash|zsh|python|perl)/i.test(c)) {
    return 'curl/wget 管道到 shell（远程代码执行风险）'
  }
  // chmod -R 777 大范围
  if (/chmod\s+-r\s+777\s+\//i.test(c)) {
    return 'chmod -R 777 根目录（破坏所有权限）'
  }
  // dd 到磁盘设备
  if (/dd\s+.*of=\/dev\/(sd|nvme|disk|hd)/i.test(c)) {
    return 'dd 写入磁盘设备（会擦除整个磁盘）'
  }
  // mkfs 格式化
  if (/mkfs\.\w+\s+\/dev\//i.test(c)) {
    return 'mkfs 格式化磁盘设备（会擦除所有数据）'
  }
  // git push --force 到 main/master
  if (/git\s+push\s+.*--force\s+.*\b(main|master)\b/i.test(c)) {
    return 'git push --force 到 main/master（会覆盖远程历史）'
  }
  // killall / pkill 范围过大
  if (/^(killall|pkill)\s+(-9|-KILL)/i.test(c)) {
    return 'killall -9 / pkill -9（会杀大量进程）'
  }

  return null
}



// 深度比对第 64 轮: 从 stdout 里检测 cd 命令的目标目录（对标 Claude Code cwd 重置检测）
function findCwdChange(stdout: string): string | null {
  // 检测 `cd /some/path` 模式的输出或 PWD 变化
  const cdMatch = stdout.match(/^(?:PWD|pwd)[:=]\s*(.+)$/m)
  if (cdMatch?.[1]) return cdMatch[1].trim()
  return null
}
