// src/mcp/McpState.ts
// MCP 连接的进程级单例状态。
//
// 背景：App.tsx 启动期 connectAllMcpServers 返回的 connections 用完即丢，
// Repl 命令 handler 拿不到。用模块级单例存住，让 /mcp 命令能读取/管理运行时连接。
//
// 设计：纯模块变量 + getter/setter，不依赖 React/Effect，任何模块都能 import 访问。
import type { McpConnection } from '@/mcp/McpClient.js'

let connections: McpConnection[] = []
let initialized = false

/** 设置运行时连接列表（App.tsx 启动期调一次） */
export function setMcpConnections(conns: McpConnection[]): void {
  connections = conns
  initialized = true
}

/** 获取当前连接列表（Repl 命令 handler 用） */
export function getMcpConnections(): McpConnection[] {
  return connections
}

/** 是否已初始化（区分"未加载"和"加载了但 0 个 server"） */
export function isMcpInitialized(): boolean {
  return initialized
}

/** 按名字查连接 */
export function findMcpConnection(name: string): McpConnection | undefined {
  return connections.find((c) => c.name === name)
}

/** 删除一个连接（断开后从列表移除） */
export function removeMcpConnection(name: string): void {
  connections = connections.filter((c) => c.name !== name)
}

/** 添加或替换一个连接（重连后用） */
export function upsertMcpConnection(conn: McpConnection): void {
  connections = [...connections.filter((c) => c.name !== conn.name), conn]
}
