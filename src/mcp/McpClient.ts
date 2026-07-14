// src/mcp/McpClient.ts
// MCP（Model Context Protocol）客户端。支持 stdio / sse / http transport。
// v1.9：从 v1.4 的纯 stdio 扩展到三种 transport，能接远程 MCP server。
//
// 配置在 .fuckcode/mcp.json：
// {
//   "mcpServers": {
//     "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
//     "remote-sse": { "url": "https://example.com/sse", "transport": "sse" },
//     "remote-http": { "url": "https://example.com/mcp", "transport": "http" }
//   }
// }
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import { buildTool } from '@/tools/Tool.js'
import type { Tool } from '@/tools/Tool.js'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface McpServerConfig {
  // stdio transport
  command?: string
  args?: string[]
  env?: Record<string, string>
  // sse/http transport（v1.9）
  url?: string
  transport?: 'stdio' | 'sse' | 'http'
}

export interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>
}

export interface McpConnection {
  name: string
  client: Client
  transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport
  tools: Tool[] // 转换后的 fuckcode 工具
}

// 加载 MCP 配置
export async function loadMcpConfig(cwd: string): Promise<McpConfig> {
  const configPath = resolve(cwd, '.fuckcode', 'mcp.json')
  try {
    await stat(configPath)
    const raw = await readFile(configPath, 'utf8')
    return JSON.parse(raw) as McpConfig
  } catch {
    return {} // 无配置返回空
  }
}

// MCP tool → fuckcode Tool 转换
function convertMcpTool(serverName: string, mcpTool: McpTool, client: Client): Tool {
  const toolName = `mcp__${serverName}__${mcpTool.name}`
  return buildTool({
    name: toolName,
    description: `[MCP/${serverName}] ${mcpTool.description ?? mcpTool.name}`,
    prompt: mcpTool.description ?? `MCP 工具 ${mcpTool.name}（来自 ${serverName}）`,
    // MCP 工具的 inputSchema 已是 JSON Schema，转成宽松的 Zod
    inputSchema: {
      parse: (x: unknown) => x,
      safeParse: (x: unknown) => ({ success: true, data: x }),
    } as never,
    jsonSchema: mcpTool.inputSchema ?? { type: 'object', properties: {} },
    isReadOnly: () => false, // MCP 工具保守不标只读
    isConcurrencySafe: () => false, // 保守不并行

    async execute(input) {
      try {
        // 深度比对第 22 轮: 工具调用超时（30s，防 MCP server 卡住 agent 死等）
        const CALL_TIMEOUT = 30000
        const result = await Promise.race([
          client.callTool({
            name: mcpTool.name,
            arguments: input as Record<string, unknown>,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`MCP 工具 ${mcpTool.name} 超时（${CALL_TIMEOUT / 1000}s）`)), CALL_TIMEOUT)
          ),
        ])
        // MCP 返回 content 数组
        const content = (result.content as Array<{ type: string; text?: string }>)
          ?.map((c) => c.text ?? '')
          .join('\n')
        return { ok: true, data: content ?? JSON.stringify(result) }
      } catch (e) {
        return { ok: false, error: `MCP 工具调用失败: ${(e as Error).message}`, isError: true }
      }
    },
  })
}

// 连接单个 MCP server，返回转换后的工具
export async function connectMcpServer(
  name: string,
  config: McpServerConfig,
): Promise<McpConnection> {
  // v1.9: 根据 config 选择 transport
  // - 有 url：按 transport 字段选 sse/http
  // - 有 command：stdio（默认）
  let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport
  if (config.url) {
    const transportType = config.transport ?? 'http'
    if (transportType === 'sse') {
      transport = new SSEClientTransport(new URL(config.url))
    } else {
      transport = new StreamableHTTPClientTransport(new URL(config.url))
    }
  } else if (config.command) {
    // 深度比对第 46 轮: stderr 累积上限（对标 Claude Code 64MB per server 修复）
    // StdioClientTransport 内部 spawn 子进程，stderr 默认无限累积
    // 用 stderr 管道 + 1MB cap 替代默认行为
    const child = await import('node:child_process')
    const { Readable } = await import('node:stream')
    const MAX_STDERR = 1024 * 1024 // 1MB cap（Claude Code 用 64MB，我们更保守）

    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...config.env } as Record<string, string>,
      // 深度比对第 46 轮: stderr 处理——捕获但限制累积（防内存泄漏）
      stderr: 'pipe', // 显式管道（而非 inherit 无限累积）
    } as ConstructorParameters<typeof StdioClientTransport>[0])
  } else {
    throw new Error(`MCP server "${name}" 配置无效：需要 command（stdio）或 url（sse/http）`)
  }

  const client = new Client(
    { name: 'fuckcode', version: '1.22.0' },
    // 深度比对第 22 轮: 暴露 roots capability（让 MCP server 知道当前工作目录）
    { capabilities: { roots: { listChanged: true } } },
  )

  // 深度比对第 22 轮: 连接超时（10s，防 server hang 阻塞启动）
  const CONNECT_TIMEOUT = 10000
  await Promise.race([
    client.connect(transport),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`MCP server "${name}" 连接超时（${CONNECT_TIMEOUT / 1000}s）`)), CONNECT_TIMEOUT)
    ),
  ])

  // 暴露 cwd 作为 root（让文件系统类 MCP server 知道工作目录）
  // 注：setRoots 可能在部分 SDK 版本不可用，用可选链容错
  ;(client as unknown as { setRoots?: (roots: unknown[]) => Promise<unknown> })?.setRoots?.([{ uri: `file://${process.cwd()}`, name: 'cwd' }]).catch(() => {})

  // list tools（深度比对第 22 轮: listTools 也加超时）
  const toolsResult = await Promise.race([
    client.listTools(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`MCP server "${name}" listTools 超时`)), 10000)
    ),
  ])
  const mcpTools = toolsResult.tools ?? []
  const tools = mcpTools.map((t) => convertMcpTool(name, t, client))

  // 深度比对第 46 轮: stderr 累积监控（对标 Claude Code 64MB per server 修复）
  const STDERR_CAP = 1024 * 1024 // 1MB
  const stderrInterval = setInterval(() => {
    try {
      const t = transport as unknown as { _process?: { stderr?: NodeJS.ReadableStream & { readableLength?: number } } }
      const proc = t._process
      if (proc?.stderr && (proc.stderr.readableLength ?? 0) > STDERR_CAP) {
        // stderr buffer 过大——读取并丢弃旧数据
        const stream = proc.stderr as NodeJS.ReadableStream & { read: (n: number) => Buffer | null }
        stream.read(STDERR_CAP - 512 * 1024) // 丢弃旧数据，保留末尾 512KB
      }
    } catch {
      // transport 可能已关闭
    }
  }, 30000)

  return { name, client, transport, tools }
}

// 连接所有配置的 MCP server，返回所有工具
// 单个 server 连接失败不阻塞其他（容错）
export async function connectAllMcpServers(
  config: McpConfig,
): Promise<{ connections: McpConnection[]; tools: Tool[]; errors: string[] }> {
  const servers = config.mcpServers ?? {}
  const connections: McpConnection[] = []
  const tools: Tool[] = []
  const errors: string[] = []

  for (const [name, serverConfig] of Object.entries(servers)) {
    try {
      const conn = await connectMcpServer(name, serverConfig)
      connections.push(conn)
      tools.push(...conn.tools)
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`)
    }
  }

  return { connections, tools, errors }
}

// 优雅关闭所有连接
export async function disconnectAll(connections: McpConnection[]): Promise<void> {
  await Promise.allSettled(
    connections.map(async (conn) => {
      try {
        await conn.client.close()
      } catch {
        // 忽略关闭错误
      }
    }),
  )
}
