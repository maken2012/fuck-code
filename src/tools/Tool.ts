// src/tools/Tool.ts
// Tool 接口 + buildTool 工厂。照搬 Claude Code 设计（简化）。
// 工具用普通 async，不依赖 Effect——中度 Effect 架构里工具层是纯业务逻辑。
import type { z } from 'zod'
import type { ReadFileState } from '@/tools/_readFileState.js'
import type { ChatMessage } from '@/llm/types.js'

// 工具执行上下文（queryLoop 传入）
export interface ToolContext {
  cwd: string
  abortSignal: AbortSignal
  /** M4：跨工具共享的"已读文件"状态。Read 写入；Edit/Write 执行前校验（hard guard）。 */
  readFileState: ReadFileState
  /** v1.7：父对话历史（仅 Task fork 模式用，其他工具忽略）。queryLoop 执行 Task 时传入。 */
  parentHistory?: ChatMessage[]
  /** 深度比对第 44 轮: 进度回调（Bash 长命令实时输出用，对标 Claude Code onProgress） */
  onProgress?: (data: { lines: string[]; totalLines: number; elapsedMs: number }) => void
}

// 工具执行结果：成功带 data，失败带 error
export type ToolResult =
  | { ok: true; data: unknown; isError?: false }
  | { ok: false; error: string; isError: true }

// 工具接口（泛型 I=入参类型）
export interface Tool<I = unknown> {
  name: string // 'Read' / 'Glob' / 'Grep' ...
  description: string // 给用户看的一行中文说明
  prompt: string // 给模型看的中文详细说明（注入 system prompt）
  inputSchema: z.ZodType<I> // Zod 入参校验（运行时校验模型传来的 input）

  // Anthropic tools API 格式的 input_schema。各工具显式提供，避免写通用 zodToJsonSchema。
  jsonSchema?: object

  isReadOnly?: () => boolean // 默认 false（buildTool 填充）；true = 不改文件系统
  isConcurrencySafe?: () => boolean // 默认 false；true = 可与其他只读工具并行

  // 执行：入参 + 上下文 → 结果
  execute(input: I, ctx: ToolContext): Promise<ToolResult>

  // 把结果格式化给模型看（控制体积，超限截断）。默认 JSON.stringify。
  formatResult?(data: unknown): string
}

// 工厂：填充安全默认值（fail-closed：未显式声明一律视为可变 + 不可并发）
export function buildTool<I>(def: Tool<I>): Tool<I> {
  return {
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    formatResult: (data) => (typeof data === 'string' ? data : JSON.stringify(data, null, 2)),
    ...def,
  }
}
