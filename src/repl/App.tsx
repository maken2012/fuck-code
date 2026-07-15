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

  // v1.4: 连接 MCP servers（如有 .fuckcode/mcp.json），失败不阻塞启动
  let mcpToolsCount = 0
  // v1.11: safe-mode 跳过 MCP
  if (process.env.FUCKCODE_SAFE_MODE !== '1') {
  try {
    const { loadMcpConfig, connectAllMcpServers } = await import('@/mcp/McpClient.js')
    const mcpConfig = await loadMcpConfig(process.cwd())
    if (mcpConfig.mcpServers && Object.keys(mcpConfig.mcpServers).length > 0) {
      const serverCount = Object.keys(mcpConfig.mcpServers).length
      process.stderr.write(`\x1b[2m连接 ${serverCount} 个 MCP server...\x1b[0m\n`)
      const result = await connectAllMcpServers(mcpConfig)
      mcpToolsCount = result.tools.length
      // v1.13: 存入 McpState 单例，让 /mcp 命令能读取/管理运行时连接
      const { setMcpConnections } = await import('@/mcp/McpState.js')
      setMcpConnections(result.connections)
      if (mcpToolsCount > 0) {
        process.stderr.write(`\x1b[2m✓ MCP: 加载 ${mcpToolsCount} 个工具（${result.connections.map((c) => c.name).join(', ')}）\x1b[0m\n`)
      }
      if (result.errors.length > 0) {
        process.stderr.write(`\x1b[33m⚠ MCP 连接失败: ${result.errors.join('; ')}\x1b[0m\n`)
      }
    }
  } catch (e) {
    process.stderr.write(`\x1b[33m⚠ MCP 初始化失败（忽略）: ${String(e)}\x1b[0m\n`)
  }
  } // end if !safe-mode

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
