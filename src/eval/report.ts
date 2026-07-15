// src/eval/report.ts
// 评测报告生成：终端表格 + JSON 明细。
//
// - 终端表格：直接写到 stdout，带 ANSI 颜色
// - JSON 明细：写到 .fuckcode/eval-results/<timestamp>.json
import type { EvalReport, TaskRunResult } from '@/eval/types.js'
import { fuckcodeDir } from '@/services/Paths.js'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

// ANSI 颜色
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
}

/** 渲染报告到终端 */
export function renderReport(report: EvalReport): string {
  const lines: string[] = []

  // 标题
  lines.push(`${C.bold}${C.cyan}╔══════════════════════════════════════════╗${C.reset}`)
  lines.push(`${C.bold}${C.cyan}║       FUCKCODE EVAL 报告                  ║${C.reset}`)
  lines.push(`${C.bold}${C.cyan}╚══════════════════════════════════════════╝${C.reset}`)
  lines.push('')

  // 元信息
  lines.push(`${C.dim}模型:${C.reset} ${report.model}  ${C.dim}模式:${C.reset} ${report.llmMode}  ${C.dim}耗时:${C.reset} ${formatDuration(report.durationMs)}`)
  lines.push('')

  // 任务表格
  lines.push(`${C.bold}任务明细${C.reset}`)
  lines.push(`${C.dim}┌──────────────────────────────────┬────────┬────────┬─────────┬────────┬──────────┐${C.reset}`)
  lines.push(`${C.dim}│${C.reset} ${'任务名'.padEnd(32)} ${C.dim}│${C.reset} ${'状态'.padEnd(6)} ${C.dim}│${C.reset} ${'难度'.padEnd(6)} ${C.dim}│${C.reset} ${'token'.padEnd(7)} ${C.dim}│${C.reset} ${'轮次'.padEnd(6)} ${C.dim}│${C.reset} ${'耗时'.padEnd(8)} ${C.dim}│${C.reset}`)
  lines.push(`${C.dim}├──────────────────────────────────┼────────┼────────┼─────────┼────────┼──────────┤${C.reset}`)

  for (const result of report.results) {
    const name = truncate(result.taskName, 32).padEnd(32)
    const status = formatStatus(result.status)
    const difficulty = (result.difficulty ?? '?').padEnd(6)
    const tokens = formatTokens(result.totalTokens.input + result.totalTokens.output).padEnd(7)
    const turns = String(result.turns.length).padEnd(6)
    const duration = formatDuration(result.durationMs).padEnd(8)
    lines.push(`${C.dim}│${C.reset} ${name} ${C.dim}│${C.reset} ${status} ${C.dim}│${C.reset} ${difficulty} ${C.dim}│${C.reset} ${tokens} ${C.dim}│${C.reset} ${turns} ${C.dim}│${C.reset} ${duration} ${C.dim}│${C.reset}`)
  }

  lines.push(`${C.dim}└──────────────────────────────────┴────────┴────────┴─────────┴────────┴──────────┘${C.reset}`)
  lines.push('')

  // 汇总
  const s = report.summary
  lines.push(`${C.bold}汇总${C.reset}`)
  lines.push(`  通过率: ${colorizePassRate(s.passRate)} (${s.passed}/${s.total})`)
  lines.push(`  失败: ${s.failed}  错误: ${s.errored}  超时: ${s.timedOut}`)
  lines.push(`  Token: ${C.bold}${formatTokens(s.totalInputTokens + s.totalOutputTokens)}${C.reset} (输入 ${formatTokens(s.totalInputTokens)} / 输出 ${formatTokens(s.totalOutputTokens)} / 缓存 ${formatTokens(s.totalCacheReadTokens)})`)

  // 按难度
  if (Object.keys(s.byDifficulty).length > 0) {
    lines.push(`  ${C.dim}按难度:${C.reset}`)
    for (const [diff, stat] of Object.entries(s.byDifficulty)) {
      lines.push(`    ${diff}: ${colorizePassRate(stat.passRate)} (${stat.passed}/${stat.total})`)
    }
  }

  lines.push('')

  // 失败详情
  const failures = report.results.filter((r) => r.status === 'fail' || r.status === 'error')
  if (failures.length > 0) {
    lines.push(`${C.bold}${C.red}失败详情${C.reset}`)
    for (const f of failures) {
      lines.push(`  ${C.red}●${C.reset} ${f.taskName} (${f.status})`)
      lines.push(`    ${C.dim}判定:${C.reset} ${truncate(f.judgeResult.reason, 200)}`)
      if (f.error) lines.push(`    ${C.dim}错误:${C.reset} ${f.error}`)
    }
    lines.push('')
  }

  // 多维度评分详情（开放式任务）
  const rubricTasks = report.results.filter((r) => r.judgeResult.dimensionScores && r.judgeResult.dimensionScores.length > 0)
  if (rubricTasks.length > 0) {
    lines.push(`${C.bold}${C.cyan}维度评分明细${C.reset}`)
    for (const r of rubricTasks) {
      const icon = r.status === 'pass' ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`
      const total = r.judgeResult.score ?? 0
      lines.push(`  ${icon} ${r.taskName} ${C.dim}→${C.reset} 加权 ${colorizeScore(total)}`)
      for (const d of r.judgeResult.dimensionScores!) {
        const bar = scoreBar(d.score)
        lines.push(`    ${d.name.padEnd(12)} ${bar} ${(d.score * 100).toFixed(0)}% ${C.dim}(${(d.weight * 100).toFixed(0)}%)${C.reset}`)
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}

/** 0-1 分数转彩色条 */
function colorizeScore(score: number): string {
  const pct = `${(score * 100).toFixed(0)}%`
  if (score >= 0.8) return `${C.green}${C.bold}${pct}${C.reset}`
  if (score >= 0.5) return `${C.yellow}${pct}${C.reset}`
  return `${C.red}${pct}${C.reset}`
}

/** 分数转进度条 [████░░░░] */
function scoreBar(score: number): string {
  const filled = Math.round(score * 5)
  const bar = '█'.repeat(filled) + '░'.repeat(5 - filled)
  const color = score >= 0.7 ? C.green : score >= 0.4 ? C.yellow : C.red
  return `${color}[${bar}]${C.reset}`
}

/** 把报告写入 JSON 文件，返回文件路径 */
export async function saveReportJson(report: EvalReport): Promise<string> {
  const dir = join(fuckcodeDir(), 'eval-results')
  await mkdir(dir, { recursive: true })
  const ts = new Date(report.startedAt).toISOString().replace(/[:.]/g, '-')
  const path = join(dir, `${ts}.json`)
  await writeFile(path, JSON.stringify(report, null, 2), 'utf8')
  return path
}

// ─── 辅助函数 ─────────────────────────────────────────────

function formatStatus(status: string): string {
  switch (status) {
    case 'pass': return `${C.green}✓ PASS${C.reset}${' '.repeat(0)}`
    case 'fail': return `${C.red}✗ FAIL${C.reset}${' '.repeat(0)}`
    case 'error': return `${C.yellow}⚡ ERR ${C.reset}${' '.repeat(0)}`
    case 'timeout': return `${C.yellow}⏱ TIME${C.reset}${' '.repeat(0)}`
    default: return status.padEnd(6)
  }
}

function colorizePassRate(rate: number): string {
  const pct = `${(rate * 100).toFixed(1)}%`
  if (rate >= 0.8) return `${C.green}${C.bold}${pct}${C.reset}`
  if (rate >= 0.5) return `${C.yellow}${pct}${C.reset}`
  return `${C.red}${pct}${C.reset}`
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

function truncate(s: string, max: number): string {
  // 去掉 ANSI 颜色码后的实际长度
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, '')
  if (stripped.length <= max) return s
  return s.slice(0, max) + '...'
}
