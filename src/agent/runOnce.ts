// src/agent/runOnce.ts
// 一次性（非交互）模式：用户传 prompt，工具跑完输出结果到 stdout 后退出。
// 用法：fuckcode "帮我读一下 package.json" 或 cat file | fuckcode "解释这段"
//
// 与 REPL 的区别：
// - 不进 Ink，纯 stdout/stderr 文本输出
// - 工具权限按 config 走（无弹窗，ask 规则在非交互下退化为 deny 以保安全）
// - Ctrl+C 直接终止进程
// - 支持 stdin 管道（追加到 prompt）
import { queryLoop } from '@/agent/queryLoop.js'
import { buildSystemPrompt } from '@/agent/systemPrompt.js'
import { PLAN_MODE_INSTRUCTION } from '@/agent/planPrompt.js'
import type { QueryEvent } from '@/agent/types.js'
import { getAllTools } from '@/tools/registry.js'
import { getConfig } from '@/services/runtime.js'
import { createSession } from '@/services/Session.js'
import type { PermissionMode } from '@/permissions/modes.js'

export interface RunOnceOpts {
  prompt: string
  stdin?: string                      // 管道传入的额外内容（追加到 prompt）
  modelOverride?: string
  apiKeyOverride?: string
  apiBaseUrlOverride?: string
  /** 非交互模式默认 acceptEdits（允许写操作不弹窗）；用 bypassPermissions 跳过所有检查 */
  permissionMode?: PermissionMode
  /** v1.13: 输出格式——text（默认，流式 stdout）/ json（CI 友好，结束时输出结构化结果） */
  outputFormat?: 'text' | 'json'
  /** v1.13: 最大工具调用轮次（防止死循环，默认 25） */
  maxTurns?: number
  /** 测试用：注入 mock queryLoop（生产代码不传） */
  _queryLoopOverride?: (opts: object) => AsyncGenerator<QueryEvent>
}

export async function runOnce(opts: RunOnceOpts): Promise<void> {
  const config = await getConfig().catch(() => null)
  const model = opts.modelOverride ?? config?.value.model ?? 'claude-sonnet-4-5-20250929'
  const apiKey = opts.apiKeyOverride ?? config?.value.apiKey
  const apiBaseUrl = opts.apiBaseUrlOverride ?? config?.value.apiBaseUrl

  // 拼接 prompt + stdin
  const fullPrompt = opts.stdin ? `${opts.prompt}\n\n--- stdin ---\n${opts.stdin}` : opts.prompt

  // 非交互模式：默认 acceptEdits（写操作不弹窗）。
  // 如果 config 是 bypassPermissions 则尊重；plan 则保持 plan。
  // 重要：非交互下 ask 会变成"无人回答"的死锁，所以不能让默认 default 模式跑（会卡）。
  const permissionMode: PermissionMode =
    opts.permissionMode ?? (config?.value.permissionMode === 'bypassPermissions'
      ? 'bypassPermissions'
      : config?.value.permissionMode === 'plan'
        ? 'plan'
        : 'acceptEdits')

  // 创建 session 用于持久化（可选，失败不阻塞）
  let sessionId: string | undefined
  try {
    sessionId = await createSession(process.cwd())
  } catch {
    // 无 session 也能跑（queryLoop 不传 sessionId 退化为不持久化）
  }

  const ac = new AbortController()
  // 非交互模式：SIGINT 直接退出
  process.on('SIGINT', () => {
    ac.abort()
    process.exit(130)
  })

  // 深度比对第 32 轮: stdout 检测——管道时禁用 ANSI 颜色
  const isTTY = process.stdout.isTTY
  const dim = isTTY ? '\x1b[2m' : ''
  const reset = isTTY ? '\x1b[0m' : ''
  const yellow = isTTY ? '\x1b[33m' : ''
  const red = isTTY ? '\x1b[31m' : ''

  process.stderr.write(`${dim}模型: ${model} · 模式: ${permissionMode}${reset}\n`)

  // plan 模式：叠加计划指令到 system prompt，并在 prompt 前加引导
  const isPlan = permissionMode === 'plan'
  const baseSystem = await buildSystemPrompt({ tools: getAllTools() })
  const system = isPlan ? baseSystem + PLAN_MODE_INSTRUCTION : baseSystem
  const guidedPrompt = isPlan ? `请为以下需求产出一份实施计划：\n\n${fullPrompt}` : fullPrompt

  const queryLoopFn = opts._queryLoopOverride ?? (queryLoop as unknown as (o: object) => AsyncGenerator<QueryEvent>)

  // v1.13: JSON 模式累积结果，结束时一次性输出；text 模式流式输出
  const jsonMode = opts.outputFormat === 'json'
  const maxTurns = opts.maxTurns ?? 25
  let jsonResult = ''
  let jsonTools: Array<{ tool: string; ok: boolean }> = []
  let jsonUsage = { input: 0, output: 0, cacheRead: 0 }
  let turnCount = 0

  try {
    for await (const event of queryLoopFn({
      history: [],
      userInput: guidedPrompt,
      model,
      system,
      maxTokens: config?.value.maxTokens ?? 8192,
      signal: ac.signal,
      apiKey,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
      cwd: process.cwd(),
      tools: getAllTools(),
      permissionMode,
      permissions: config?.value.permissions ?? { allow: [], ask: [], deny: [] },
      sessionId,
      contextWindow: config?.value.contextWindow ?? 200000,
    })) {
      switch (event.type) {
        case 'text_delta':
          jsonResult += event.text
          if (!jsonMode) {
            // 深度比对第 32 轮: stdout 纯文本（管道友好，对标 Claude Code -p）
            process.stdout.write(event.text)
          }
          break
        case 'tool_use_start': {
          jsonTools.push({ tool: event.tool, ok: true })
          if (!jsonMode) {
            // 深度比对第 32 轮: 用 ASCII tag（对标 REPL 改造，去 emoji）
            const summary = summarizeTool(event.tool, event.input)
            process.stderr.write(`\n${dim}[${event.tool}]${summary ? ` ${summary}` : ''}${reset}\n`)
          }
          break
        }
        case 'tool_result':
          if (!event.ok) {
            // 标记最后一个同名工具为失败
            for (let j = jsonTools.length - 1; j >= 0; j--) {
              if (jsonTools[j]!.tool === event.tool) { jsonTools[j]!.ok = false; break }
            }
            if (!jsonMode) {
              process.stderr.write(`${yellow}[FAIL] ${event.tool}: ${event.content}${reset}\n`)
            }
          }
          break
        case 'permission_request':
          event.resolve('deny')
          if (!jsonMode) process.stderr.write(`${yellow}[WARN] 非交互模式拒绝: ${event.tool}${reset}\n`)
          break
        case 'compacted':
          if (!jsonMode) process.stderr.write(`${dim}[上下文已压缩]${reset}\n`)
          break
        case 'turn_end':
          turnCount++
          // v1.13: max-turns 安全阀（防止死循环）
          if (turnCount >= maxTurns) {
            if (!jsonMode) process.stderr.write(`${yellow}[达到最大轮次 ${maxTurns}，停止]${reset}\n`)
            break
          }
          break
        case 'usage': {
          jsonUsage = { input: event.input, output: event.output, cacheRead: event.cacheRead }
          if (!jsonMode) {
            const cost = event.input + event.output
            process.stderr.write(`\n${dim}[${cost} tokens · cache ${event.cacheRead}]${reset}\n`)
          }
          break
        }
        case 'error':
          if (!jsonMode) process.stderr.write(`\n${red}错误: ${event.error.message}${reset}\n`)
          break
        case 'aborted':
          if (!jsonMode) process.stderr.write(`\n${yellow}[已中断]${reset}\n`)
          break
        case 'done':
          break
      }
      if (turnCount >= maxTurns) break
    }
    if (jsonMode) {
      // JSON 模式：结构化结果到 stdout（CI 解析友好）
      process.stdout.write(JSON.stringify({
        result: jsonResult,
        tools: jsonTools,
        usage: jsonUsage,
        turns: turnCount,
      }, null, 2) + '\n')
    } else {
      process.stdout.write('\n')
    }
  } catch (e) {
    process.stderr.write(`\n\x1b[31m致命错误: ${String(e)}\x1b[0m\n`)
    process.exit(1)
  }
}

function summarizeTool(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  if (tool === 'Bash') return String(i.command ?? '').slice(0, 60)
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') return String(i.file_path ?? '')
  if (tool === 'Grep' || tool === 'Glob') return String(i.pattern ?? '')
  return JSON.stringify(input).slice(0, 60)
}
