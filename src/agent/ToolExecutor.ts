// src/agent/ToolExecutor.ts
// 工具执行器类。封装 queryLoop 里的工具执行逻辑：
// 权限检查 → 并发分组 → 并行/串行执行 → 结果收集。
// 从 queryLoop 抽出，遵循单一职责原则。
import type { Tool } from '@/tools/Tool.js'
import type { ContentBlock } from '@/llm/types.js'
import type { QueryEvent } from '@/agent/types.js'
import type { ReadFileState } from '@/tools/_readFileState.js'
import { PermissionManager } from '@/permissions/PermissionManager.js'
import type { PermissionMode } from '@/permissions/modes.js'
import { triggerHooks } from '@/hooks/HookManager.js'
import type { HooksFile } from '@/hooks/HookManager.js'

export interface ToolUseRequest {
  id: string
  name: string
  input: unknown
  _needsAsk?: boolean  // 内部标记：权限决策为 ask 时由 queryLoop 处理交互
}

export interface ExecutionContext {
  cwd: string
  abortSignal: AbortSignal
  readFileState: ReadFileState
  permissionMode: PermissionMode
  permissions: { allow: string[]; ask: string[]; deny: string[] }
  hooks: HooksFile
  parentHistory?: unknown[]
}

export interface ExecutionResult {
  blocks: ContentBlock[]
  events: QueryEvent[]
}

/**
 * 工具执行器。负责：
 * 1. 权限检查（含 PreToolUse hook + askPermission 交互）
 * 2. 并发分组（只读工具并行，写工具串行）
 * 3. 执行并收集结果
 */
export class ToolExecutor {
  constructor(
    private readonly tools: Tool[],
    private readonly findTool: (name: string, tools: Tool[]) => Tool | undefined,
  ) {}

  async *execute(
    toolUses: ToolUseRequest[],
    ctx: ExecutionContext,
    messages: unknown[],
    askHandler?: (toolName: string, input: unknown) => Promise<'allow' | 'deny'>,
  ): AsyncGenerator<QueryEvent, ContentBlock[]> {
    const blocks: ContentBlock[] = []

    // 第一阶段：权限检查。返回 permitted + rejected（需要 yield 的拒绝事件）
    const { permitted, rejected } = await this.checkPermissions(toolUses, ctx, askHandler)

    // yield 被拒绝的工具结果 + 收集 blocks
    for (const { block, event } of rejected) {
      blocks.push(block)
      yield event
    }

    if (permitted.length === 0) return blocks

    // 第二阶段：并发分组
    const { concurrencySafe, serial } = this.partition(permitted)

    // 第三阶段：并发安全工具并行执行
    if (concurrencySafe.length > 0) {
      const results = await Promise.all(
        concurrencySafe.map(async ({ request, tool, input }) => {
          const result = await tool.execute(input, {
            cwd: ctx.cwd,
            abortSignal: ctx.abortSignal,
            readFileState: ctx.readFileState,
            parentHistory: messages as never,
          })
          return { request, tool, result }
        }),
      )
      // 按原始顺序排序
      const orderMap = new Map(toolUses.map((tu, i) => [tu.id, i]))
      results.sort((a, b) => (orderMap.get(a.request.id) ?? 0) - (orderMap.get(b.request.id) ?? 0))
      for (const { request, tool, result } of results) {
        const { block, event } = this.formatResult(request, tool, result)
        blocks.push(block)
        yield event
      }
    }

    // 第四阶段：串行工具依次执行
    for (const { request, tool, input } of serial) {
      const result = await tool.execute(input, {
        cwd: ctx.cwd,
        abortSignal: ctx.abortSignal,
        readFileState: ctx.readFileState,
        parentHistory: messages as never,
      })
      const { block, event } = this.formatResult(request, tool, result)
      blocks.push(block)
      yield event
    }

    return blocks
  }

  /**
   * 执行已通过权限检查的工具（queryLoop 用）。
   * 只做并发分组 + 执行 + 结果收集，不处理权限。
   */
  async *executePermitted(
    toolUses: ToolUseRequest[],
    ctx: { cwd: string; abortSignal: AbortSignal; readFileState: ReadFileState; parentHistory: unknown[] },
  ): AsyncGenerator<QueryEvent, { blocks: ContentBlock[]; events: QueryEvent[] }> {
    const blocks: ContentBlock[] = []
    const events: QueryEvent[] = []

    // 查找工具 + 分组
    const withTools = toolUses
      .map((tu) => ({ request: tu, tool: this.findTool(tu.name, this.tools) }))
      .filter((x): x is { request: ToolUseRequest; tool: Tool } => x.tool !== undefined)

    const concurrencySafe = withTools.filter((x) => x.tool.isConcurrencySafe?.())
    const serial = withTools.filter((x) => !x.tool.isConcurrencySafe?.())

    // 并发安全工具并行执行
    if (concurrencySafe.length > 0) {
      const results = await Promise.all(
        concurrencySafe.map(async ({ request, tool }) => {
          const result = await tool.execute(request.input, {
            cwd: ctx.cwd,
            abortSignal: ctx.abortSignal,
            readFileState: ctx.readFileState,
            parentHistory: ctx.parentHistory as never,
          })
          return { request, tool, result }
        }),
      )
      const orderMap = new Map(toolUses.map((tu, i) => [tu.id, i]))
      results.sort((a, b) => (orderMap.get(a.request.id) ?? 0) - (orderMap.get(b.request.id) ?? 0))
      for (const { request, tool, result } of results) {
        const { block, event } = this.formatResult(request, tool, result)
        blocks.push(block)
        events.push(event)
        yield event
      }
    }

    // 串行工具依次执行
    for (const { request, tool } of serial) {
      const result = await tool.execute(request.input, {
        cwd: ctx.cwd,
        abortSignal: ctx.abortSignal,
        readFileState: ctx.readFileState,
        parentHistory: ctx.parentHistory as never,
      })
      const { block, event } = this.formatResult(request, tool, result)
      blocks.push(block)
      events.push(event)
      yield event
    }

    return { blocks, events }
  }

  /** 权限检查 + PreToolUse hook。返回 { permitted, rejected } */
  private async checkPermissions(
    toolUses: ToolUseRequest[],
    ctx: ExecutionContext,
    askHandler?: (toolName: string, input: unknown) => Promise<'allow' | 'deny'>,
  ): Promise<{
    permitted: { request: ToolUseRequest; tool: Tool; input: unknown }[]
    rejected: { block: ContentBlock; event: QueryEvent }[]
  }> {
    const permitted: { request: ToolUseRequest; tool: Tool; input: unknown }[] = []
    const rejected: { block: ContentBlock; event: QueryEvent }[] = []

    const addRejected = (tu: ToolUseRequest, content: string) => {
      const block: ContentBlock = { type: 'tool_result', tool_use_id: tu.id, content, is_error: true }
      const event: QueryEvent = { type: 'tool_result', tool: tu.name, ok: false, content }
      rejected.push({ block, event })
    }

    for (const tu of toolUses) {
      const tool = this.findTool(tu.name, this.tools)
      if (!tool) {
        addRejected(tu, `错误：未知工具 ${tu.name}`)
        continue
      }

      // PreToolUse hook
      let effectiveInput: unknown = tu.input
      const preHook = await triggerHooks(
        'PreToolUse',
        { tool: tu.name, toolInput: tu.input },
        ctx.hooks,
        ctx.cwd,
      )
      if (preHook.updatedInput) effectiveInput = preHook.updatedInput
      if (preHook.permissionDecision === 'deny') {
        addRejected(tu, `hook 拒绝: ${preHook.additionalContext ?? ''}`)
        continue
      }

      // 权限决策管线——通过 PermissionManager 类（统一入口）
      const permManager = PermissionManager.fromConfig({
        permissionMode: ctx.permissionMode,
        permissions: ctx.permissions,
      })
      const perm = await permManager.check(tool, effectiveInput, {
        cwd: ctx.cwd,
        abortSignal: ctx.abortSignal,
        readFileState: ctx.readFileState,
      })

      if (perm.decision === 'deny') {
        addRejected(tu, `权限拒绝: ${perm.reason ?? '匹配 deny 规则'}`)
        continue
      }

      if (perm.decision === 'ask') {
        if (askHandler) {
          const userDecision = await askHandler(tu.name, effectiveInput)
          if (userDecision === 'deny') {
            addRejected(tu, `用户拒绝执行 ${tu.name}`)
            continue
          }
        }
      }

      permitted.push({ request: tu, tool, input: effectiveInput })
    }

    return { permitted, rejected }
  }

  /** 按 isConcurrencySafe 分组 */
  private partition(
    permitted: { request: ToolUseRequest; tool: Tool; input: unknown }[],
  ): {
    concurrencySafe: typeof permitted
    serial: typeof permitted
  } {
    const concurrencySafe: typeof permitted = []
    const serial: typeof permitted = []
    for (const p of permitted) {
      if (p.tool.isConcurrencySafe?.()) concurrencySafe.push(p)
      else serial.push(p)
    }
    return { concurrencySafe, serial }
  }

  /** 格式化工具结果为 ContentBlock + QueryEvent */
  private formatResult(
    request: ToolUseRequest,
    tool: Tool,
    result: { ok: boolean; data?: unknown; error?: string },
  ): { block: ContentBlock; event: QueryEvent } {
    const content = result.ok
      ? tool.formatResult
        ? tool.formatResult(result.data)
        : JSON.stringify(result.data)
      : `错误: ${result.error}`
    return {
      block: {
        type: 'tool_result',
        tool_use_id: request.id,
        content,
        is_error: result.ok ? undefined : true,
      },
      event: {
        type: 'tool_result',
        tool: request.name,
        ok: result.ok,
        content,
      },
    }
  }
}
