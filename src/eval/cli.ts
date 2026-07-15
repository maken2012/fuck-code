// src/eval/cli.ts
// Eval harness CLI 入口。
//
// 用法：
//   bun run src/eval/cli.ts <task-file>              # 跑单个任务文件
//   bun run src/eval/cli.ts --dir <tasks-dir>        # 跑目录下所有 .task.json
//   bun run src/eval/cli.ts --dir <dir> --record     # 录制模式（真实调用，保存响应）
//   bun run src/eval/cli.ts --dir <dir> --replay     # 回放模式（零成本复现）
//   bun run src/eval/cli.ts <task-file> --model <m>  # 覆盖模型
//   bun run src/eval/cli.ts --dir <dir> -j 3         # 并发 3 个任务
//   bun run src/eval/cli.ts <task-file> --retries 2  # 失败重试 2 次
//   bun run src/eval/cli.ts <task-file> --no-cleanup # 保留工作区（调试用）
//
// 这是独立入口，不进 cli.tsx 的 commander（保持 eval 和主程序解耦）。
import type { EvalTask, RunnerOpts, LlmMode } from '@/eval/types.js'
import { parseTask, safeParseTask, formatTaskErrors } from '@/eval/taskSchema.js'
import { EvalRunner } from '@/eval/runner.js'
import { renderReport, saveReportJson } from '@/eval/report.js'
import { fuckcodeDir } from '@/services/Paths.js'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// ANSI 颜色
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
}

interface ParsedArgs {
  taskFiles: string[]
  dir?: string
  model?: string
  apiKey?: string
  apiBaseUrl?: string
  provider?: string
  record: boolean
  replay: boolean
  concurrency: number
  retries: number
  timeoutMs?: number
  cleanup: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    taskFiles: [],
    concurrency: 1,
    retries: 0,
    cleanup: true,
    record: false,
    replay: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = argv[i + 1]

    if (arg === '--dir' || arg === '-d') {
      args.dir = next
      i++
    } else if (arg === '--model' || arg === '-m') {
      args.model = next
      i++
    } else if (arg === '--api-key') {
      args.apiKey = next
      i++
    } else if (arg === '--api-base-url') {
      args.apiBaseUrl = next
      i++
    } else if (arg === '--provider') {
      args.provider = next
      i++
    } else if (arg === '--record') {
      args.record = true
    } else if (arg === '--replay') {
      args.replay = true
    } else if (arg === '--concurrency' || arg === '-j') {
      args.concurrency = parseInt(next ?? '1', 10)
      i++
    } else if (arg === '--retries') {
      args.retries = parseInt(next ?? '0', 10)
      i++
    } else if (arg === '--timeout') {
      args.timeoutMs = parseInt(next ?? '120000', 10)
      i++
    } else if (arg === '--no-cleanup') {
      args.cleanup = false
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (!arg.startsWith('-')) {
      args.taskFiles.push(resolve(arg))
    }
  }

  return args
}

function printHelp(): void {
  process.stdout.write(`
${C.bold}fuckcode eval${C.reset} — 自动化编码评测

${C.bold}用法:${C.reset}
  bun run src/eval/cli.ts <task-file>              跑单个任务
  bun run src/eval/cli.ts --dir <dir>              跑目录下所有 *.task.json
  bun run src/eval/cli.ts --dir <dir> --record     录制模式（真实调用 LLM）
  bun run src/eval/cli.ts --dir <dir> --replay     回放模式（零成本复现）

${C.bold}选项:${C.reset}
  -m, --model <name>      覆盖模型
  --api-key <key>         覆盖 apiKey
  --api-base-url <url>    覆盖 apiBaseUrl
  --provider <p>          anthropic | openai | openai-compatible
  -j, --concurrency <n>   并发任务数（默认 1）
  --retries <n>           失败重试次数（默认 0）
  --timeout <ms>          单任务超时（默认 120000）
  --no-cleanup            保留工作区（调试用）
  -h, --help              显示帮助

${C.bold}任务文件:${C.reset}
  JSON 格式，schema 见 src/eval/taskSchema.ts
  示例见 src/eval/tasks/

${C.bold}示例:${C.reset}
  bun run src/eval/cli.ts src/eval/tasks/01-add-function.task.json
  bun run src/eval/cli.ts --dir src/eval/tasks --record
  bun run src/eval/cli.ts --dir src/eval/tasks --replay -j 3
`)
}

/** 收集任务文件：单个文件或目录下所有 .task.json */
async function collectTasks(args: ParsedArgs): Promise<EvalTask[]> {
  const tasks: EvalTask[] = []
  const errors: string[] = []

  const loadFile = async (filePath: string) => {
    try {
      const raw = await readFile(filePath, 'utf8')
      const json = JSON.parse(raw)
      const [task, err] = safeParseTask(json)
      if (err) {
        errors.push(`${filePath}:\n${formatTaskErrors(err)}`)
      } else if (task) {
        tasks.push(task as EvalTask)
      }
    } catch (e) {
      errors.push(`${filePath}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (args.dir) {
    const dirPath = resolve(args.dir)
    try {
      const entries = await readdir(dirPath)
      const taskFiles = entries
        .filter((f) => f.endsWith('.task.json'))
        .sort()
        .map((f) => join(dirPath, f))
      for (const f of taskFiles) await loadFile(f)
    } catch (e) {
      process.stderr.write(`${C.red}无法读取目录 ${args.dir}: ${e}${C.reset}\n`)
      process.exit(1)
    }
  }

  for (const f of args.taskFiles) await loadFile(f)

  if (errors.length > 0) {
    process.stderr.write(`${C.red}任务文件校验失败:${C.reset}\n`)
    for (const e of errors) process.stderr.write(`  ${e}\n`)
    process.exit(1)
  }

  return tasks
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  if (argv.length === 0) {
    printHelp()
    process.exit(0)
  }

  const args = parseArgs(argv)

  // 校验：必须指定任务源
  if (args.taskFiles.length === 0 && !args.dir) {
    process.stderr.write(`${C.red}错误：必须指定任务文件或 --dir${C.reset}\n`)
    printHelp()
    process.exit(1)
  }

  // record 和 replay 互斥
  if (args.record && args.replay) {
    process.stderr.write(`${C.red}错误：--record 和 --replay 不能同时用${C.reset}\n`)
    process.exit(1)
  }

  // 收集任务
  const tasks = await collectTasks(args)
  if (tasks.length === 0) {
    process.stderr.write(`${C.yellow}没有找到任何任务${C.reset}\n`)
    process.exit(0)
  }

  // 确定 LLM 模式
  const llmMode: LlmMode = args.replay ? 'replay' : args.record ? 'record' : 'live'

  process.stderr.write(`${C.cyan}${C.bold}FUCKCODE EVAL${C.reset} ${C.dim}—${C.reset} ${tasks.length} 个任务 · 模式 ${llmMode} · 并发 ${args.concurrency}\n\n`)

  // record/replay 目录
  const recordDir = args.record ? join(fuckcodeDir(), 'eval-recordings') : undefined
  const replayDir = args.replay ? join(fuckcodeDir(), 'eval-recordings') : undefined

  const runnerOpts: RunnerOpts = {
    model: args.model,
    apiKey: args.apiKey,
    apiBaseUrl: args.apiBaseUrl,
    provider: args.provider as RunnerOpts['provider'],
    llmMode,
    recordDir,
    replayDir,
    concurrency: args.concurrency,
    retries: args.retries,
    timeoutMs: args.timeoutMs,
    cleanup: args.cleanup,
  }

  const runner = new EvalRunner(tasks, runnerOpts, {
    onTaskStart: (task, index, total) => {
      process.stderr.write(`${C.dim}[${index + 1}/${total}]${C.reset} ${C.bold}${task.name}${C.reset} ${C.dim}(${task.difficulty})${C.reset} ... `)
    },
    onTaskComplete: (result) => {
      const statusIcon = result.status === 'pass' ? `${C.green}✓${C.reset}` : result.status === 'fail' ? `${C.red}✗${C.reset}` : `${C.yellow}⚡${C.reset}`
      process.stderr.write(`${statusIcon} ${formatDuration(result.durationMs)} · ${formatTokens(result.totalTokens.input + result.totalTokens.output)} tokens\n`)
    },
  })

  const report = await runner.run()

  // 输出报告
  process.stdout.write(renderReport(report) + '\n')

  // 保存 JSON 明细
  const jsonPath = await saveReportJson(report)
  process.stderr.write(`${C.dim}明细已保存: ${jsonPath}${C.reset}\n`)

  // exit code：有失败就返回 1（CI 友好）
  const hasFailures = report.results.some((r) => r.status !== 'pass')
  process.exit(hasFailures ? 1 : 0)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${m}m${s}s`
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1000000).toFixed(2)}M`
}

// 入口
if (typeof Bun !== 'undefined' && import.meta.main) {
  void main().catch((e) => {
    process.stderr.write(`${C.red}eval 异常: ${e}${C.reset}\n`)
    process.exit(1)
  })
}

export { main as runEval }
