// src/services/Logger.ts
// Logger Service：结构化控制台日志。
// M1 极简：把日志写到 stderr（不污染 Ink 的 stdout 渲染）。
// 未来可扩展为 Effect Logger service / 文件落盘 / OpenTelemetry。
import { Context, Layer } from 'effect'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LoggerService {
  readonly debug: (msg: string, meta?: Record<string, unknown>) => void
  readonly info: (msg: string, meta?: Record<string, unknown>) => void
  readonly warn: (msg: string, meta?: Record<string, unknown>) => void
  readonly error: (msg: string, meta?: Record<string, unknown>) => void
}

export class Logger extends Context.Tag('Logger')<Logger, LoggerService>() {}

function makeConsoleLogger(verbose: boolean): LoggerService {
  const write = (level: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (level === 'debug' && !verbose) return
    const ts = new Date().toISOString()
    const metaStr = meta && Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : ''
    // 写 stderr，避免干扰 Ink 的 stdout
    process.stderr.write(`[${ts}] [${level.toUpperCase()}] ${msg}${metaStr}\n`)
  }
  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
  }
}

export const LoggerLive = (opts?: { verbose?: boolean }): Layer.Layer<Logger> =>
  Layer.succeed(Logger, Logger.of(makeConsoleLogger(opts?.verbose ?? false)))
