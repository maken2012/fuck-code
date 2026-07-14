// src/services/Logger.ts
// Logger Service：结构化控制台日志。
// M1 极简：把日志写到 stderr（不污染 Ink 的 stdout 渲染）。
// 深度比对第 25 轮: JSON 结构化日志 + 工具调用链路追踪（对标 Claude Code OTel span）
import { Context, Layer } from 'effect'
import { writeFile, mkdir, appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

// 深度比对第 25 轮: 结构化日志条目（对标 Claude Code OTel log event）
export interface LogEntry {
  ts: string
  level: LogLevel
  msg: string
  meta?: Record<string, unknown>
  // 工具调用链路追踪（对标 Claude Code agent_id/parent_agent_id span 属性）
  toolCallId?: string
  toolName?: string
  sessionId?: string
  turn?: number
  durationMs?: number
}

export interface LoggerService {
  readonly debug: (msg: string, meta?: Record<string, unknown>) => void
  readonly info: (msg: string, meta?: Record<string, unknown>) => void
  readonly warn: (msg: string, meta?: Record<string, unknown>) => void
  readonly error: (msg: string, meta?: Record<string, unknown>) => void
  // 深度比对第 25 轮: 工具调用追踪（对标 Claude Code tool span）
  readonly toolCall: (toolName: string, toolCallId: string, msg: string, meta?: Record<string, unknown>) => void
}

export class Logger extends Context.Tag('Logger')<Logger, LoggerService>() {}

// 日志文件路径（JSONL 格式，对标 Claude Code transcript logging）
let logFilePath: string | null = null
let fileLoggingEnabled = false

// 启用文件日志（写到 ~/.fuckcode/logs/session-<timestamp>.jsonl）
export function enableFileLogging(dir: string): void {
  logFilePath = resolve(dir, `logs/session-${Date.now()}.jsonl`)
  fileLoggingEnabled = true
}

function writeLogEntry(entry: LogEntry): void {
  // stderr 人类可读格式
  const metaStr = entry.meta && Object.keys(entry.meta).length > 0 ? ' ' + JSON.stringify(entry.meta) : ''
  const toolStr = entry.toolName ? ` [${entry.toolName}]` : ''
  const durStr = entry.durationMs != null ? ` (${entry.durationMs}ms)` : ''
  process.stderr.write(`[${entry.ts}] [${entry.level.toUpperCase()}]${toolStr} ${entry.msg}${durStr}${metaStr}\n`)

  // 深度比对第 25 轮: JSON 结构化日志写文件（对标 Claude Code JSONL transcript）
  if (fileLoggingEnabled && logFilePath) {
    const jsonl = JSON.stringify(entry) + '\n'
    void appendFile(logFilePath, jsonl).catch(() => {
      // 首次写入时确保目录存在
      void mkdir(resolve(logFilePath!, '..'), { recursive: true })
        .then(() => appendFile(logFilePath!, jsonl).catch(() => {}))
    })
  }
}

function makeConsoleLogger(verbose: boolean): LoggerService {
  const write = (level: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (level === 'debug' && !verbose) return
    writeLogEntry({
      ts: new Date().toISOString(),
      level,
      msg,
      meta,
    })
  }
  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
    // 工具调用追踪日志（对标 Claude Code claude_code.tool OTEL span）
    toolCall: (toolName, toolCallId, msg, meta) => {
      writeLogEntry({
        ts: new Date().toISOString(),
        level: 'info',
        msg,
        toolName,
        toolCallId,
        meta,
      })
    },
  }
}

export const LoggerLive = (opts?: { verbose?: boolean }): Layer.Layer<Logger> =>
  Layer.succeed(Logger, Logger.of(makeConsoleLogger(opts?.verbose ?? false)))
