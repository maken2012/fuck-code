// src/hooks/HookManager.ts
// Hook 系统。让用户在 .fuckcode/hooks.json 配置 shell 命令，
// 在工具执行前/后、用户提交 prompt 时等节点触发。
// 照搬 Claude Code / opencode 的 Hook 设计（简化版）。
//
// 支持的事件：
// - PreToolUse：工具执行前，可返回 JSON 改写决策（allow/deny/ask）或入参
// - PostToolUse：工具执行后，可返回 additionalContext
// - UserPromptSubmit：用户提交 prompt 时，可注入额外上下文
//
// Hook 是 shell 命令，通过 stdin 收到事件 JSON，stdout 输出 JSON 影响行为。
// 配置在 .fuckcode/hooks.json：
// {
//   "hooks": {
//     "PreToolUse": [
//       { "matcher": "Edit", "command": "echo 'editing' >> /tmp/fc.log" }
//     ],
//     "PostToolUse": [...],
//     "UserPromptSubmit": [...]
//   }
// }
import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart'

export interface HookConfig {
  matcher?: string      // 匹配工具名（PreToolUse/PostToolUse 用），支持通配符，如 "Edit|Write"
  command: string       // shell 命令
  timeout?: number      // 超时毫秒（默认 10000）
}

export interface HooksFile {
  hooks?: Partial<Record<HookEvent, HookConfig[]>>
}

export interface HookInput {
  event: HookEvent
  tool?: string         // 工具名（PreToolUse/PostToolUse）
  toolInput?: unknown   // 工具入参
  prompt?: string       // UserPromptSubmit 的 prompt
  result?: string       // PostToolUse 的工具结果
}

export interface HookOutput {
  // PreToolUse 可返回决策
  permissionDecision?: 'allow' | 'deny' | 'ask'
  // 任意可改写入参（PreToolUse）
  updatedInput?: unknown
  // 注入额外上下文
  additionalContext?: string
  // 错误信息（hook 失败时）
  error?: string
}

// 匹配工具名（支持 | 分隔和 * 通配符）
export function matchesMatcher(matcher: string, toolName: string): boolean {
  if (!matcher) return true // 无 matcher 匹配所有
  // | 分隔 → 任一匹配
  const parts = matcher.split('|').map((p) => p.trim())
  return parts.some((p) => {
    if (p === '*') return true
    if (p.includes('*')) {
      const regex = new RegExp('^' + p.replace(/\*/g, '.*') + '$')
      return regex.test(toolName)
    }
    return p === toolName
  })
}

// 加载 hooks 配置（从 .fuckcode/hooks.json）
export async function loadHooks(cwd: string): Promise<HooksFile> {
  const hooksPath = resolve(cwd, '.fuckcode', 'hooks.json')
  try {
    await stat(hooksPath)
    const raw = await readFile(hooksPath, 'utf8')
    return JSON.parse(raw) as HooksFile
  } catch {
    return {} // 无配置文件返回空
  }
}

// 执行单个 hook 命令，返回输出
async function runHookCommand(command: string, input: HookInput, timeout: number): Promise<HookOutput> {
  return new Promise((resolve) => {
    const proc = spawn(command, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      resolve({ error: `hook 超时（${timeout}ms）` })
    }, timeout)

    proc.stdout.on('data', (d) => (stdout += d.toString()))
    proc.stderr.on('data', (d) => (stderr += d.toString()))

    proc.on('error', (e) => {
      clearTimeout(timer)
      resolve({ error: `hook 启动失败: ${e.message}` })
    })

    proc.on('close', () => {
      clearTimeout(timer)
      // 尝试解析 stdout 为 JSON（hook 通过 JSON 输出影响行为）
      try {
        const parsed = JSON.parse(stdout) as HookOutput
        resolve(parsed)
      } catch {
        // 非 JSON：把 stdout 作为 additionalContext（如果有内容）
        resolve(stdout.trim() ? { additionalContext: stdout.trim() } : {})
      }
    })

    // 通过 stdin 传事件 JSON
    proc.stdin.write(JSON.stringify(input))
    proc.stdin.end()
  })
}

// 触发某事件的所有 hook，合并输出
export async function triggerHooks(
  event: HookEvent,
  input: Omit<HookInput, 'event'>,
  hooks: HooksFile,
  cwd: string,
): Promise<HookOutput> {
  const eventHooks = hooks.hooks?.[event] ?? []
  if (eventHooks.length === 0) return {}

  const merged: HookOutput = {}
  for (const hook of eventHooks) {
    // matcher 匹配（仅 PreToolUse/PostToolUse）
    if ((event === 'PreToolUse' || event === 'PostToolUse') && hook.matcher && input.tool) {
      if (!matchesMatcher(hook.matcher, input.tool)) continue
    }

    const output = await runHookCommand(
      hook.command,
      { event, ...input },
      hook.timeout ?? 10000,
    )

    if (output.error) {
      // hook 错误不阻塞，记录到 additionalContext
      merged.additionalContext = (merged.additionalContext ?? '') + `\n[hook 错误: ${output.error}]`
      continue
    }
    // 合并（后执行的覆盖前面的，但 additionalContext 拼接）
    if (output.permissionDecision) merged.permissionDecision = output.permissionDecision
    if (output.updatedInput) merged.updatedInput = output.updatedInput
    if (output.additionalContext) {
      merged.additionalContext = (merged.additionalContext ?? '') + output.additionalContext
    }
  }

  void cwd
  return merged
}
