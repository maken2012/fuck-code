// src/repl/App.tsx
// Ink render 入口。startRepl 是 cli.tsx 调用的对外函数。
import { render } from 'ink'
import React from 'react'
import { Repl } from '@/repl/Repl.js'
import { VERSION } from '@/version.js'
import { getRuntime, getConfig } from '@/services/runtime.js'

export interface StartReplOpts {
  verbose?: boolean
  /** CLI --model 覆盖 config */
  modelOverride?: string
  /** CLI --api-key 覆盖 config */
  apiKeyOverride?: string
  /** CLI --api-base-url 覆盖 config */
  apiBaseUrlOverride?: string
}

export async function startRepl(opts: StartReplOpts = {}): Promise<void> {
  // 启动期初始化 runtime（异步：ConfigLive 读文件是 Effect.tryPromise，
  // Layer.toRuntime 必须 runPromise 求值，见 runtime.ts 注释）。
  await getRuntime(opts)
  // 读一次 config 用于显示（如 model 名）；失败不阻塞启动，但写 stderr 提示便于调试。
  // CLI flag 覆盖 config 值（flag 优先级最高）。
  const config = await getConfig().catch((e: unknown) => {
    process.stderr.write(`警告: 配置加载失败，使用默认值: ${String(e)}\n`)
    return null
  })
  const effectiveModel = opts.modelOverride ?? config?.value.model
  const effectiveApiKey = opts.apiKeyOverride ?? config?.value.apiKey
  const effectiveApiBaseUrl = opts.apiBaseUrlOverride ?? config?.value.apiBaseUrl

  // Ink 的 useInput 需要 TTY（setRawMode）。非 TTY 环境（CI、管道、重定向 stdin）
  // 给出友好提示而非 Ink 的红色错误栈。
  if (!process.stdin.isTTY) {
    process.stderr.write(
      `${VERSION} 需要交互式终端（TTY）才能运行。\n` +
        `当前 stdin 不是 TTY。请直接在终端运行，不要用管道或重定向。\n` +
        `一次性（非交互）模式将在 M2 支持。\n`,
    )
    process.exit(1)
  }

  const instance = render(
    <Repl
      version={VERSION}
      initialModel={effectiveModel}
      initialApiKey={effectiveApiKey}
      initialApiBaseUrl={effectiveApiBaseUrl}
    />,
    {
      exitOnCtrlC: false, // 我们自己处理 Ctrl+C
    },
  )

  // 等待 Ink 实例结束（用户 /exit 时 Repl 调 exit()）
  await instance.waitUntilExit()
}
