// src/mcp/McpClient.ts
// MCP（Model Context Protocol）客户端最小版。只支持 stdio transport。
// 让 fuckcode 能连接外部 MCP server，把它们的工具注册成本地工具。
//
// 配置在 .fuckcode/mcp.json：
// {
//   "mcpServers": {
//     "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
//     "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
//   }
// }
//
// 启动时：连接所有配置的 server，list tools，转成 fuckcode Tool 注册到 registry。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import { buildTool } from '@/tools/Tool.js'
import type { Tool } from '@/tools/Tool.js'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>
}

export interface McpConnection {
  name: string
  client: Client
  transport: StdioClientTransport
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
        const result = await client.callTool({
          name: mcpTool.name,
          arguments: input as Record<string, unknown>,
        })
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
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...process.env, ...config.env } as Record<string, string>,
  })

  const client = new Client(
    { name: 'fuckcode', version: '1.4.0' },
    { capabilities: {} },
  )

  await client.connect(transport)

  // list tools
  const toolsResult = await client.listTools()
  const mcpTools = toolsResult.tools ?? []
  const tools = mcpTools.map((t) => convertMcpTool(name, t, client))

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
