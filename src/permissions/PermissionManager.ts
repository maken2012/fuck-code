// src/permissions/PermissionManager.ts
// 权限管理器类。封装权限决策管线 + 规则匹配 + ask 交互协调。
// 从 decision.ts 的裸函数 + queryLoop 的 askPermission helper 封装成对象。
import type { Tool } from '@/tools/Tool.js'
import type { ToolContext } from '@/tools/Tool.js'
import { checkPermission } from '@/permissions/decision.js'
import type { PermissionMode } from '@/permissions/modes.js'

export type PermissionUserDecision = 'allow' | 'deny'
export type PermissionDecision = 'allow' | 'ask' | 'deny'

export interface PermissionCheckResult {
  decision: PermissionDecision
  reason?: string
}

/**
 * 权限管理器。封装：
 * 1. 权限决策管线（PermissionMode → deny → allow → 工具内容级 → ask → 默认）
 * 2. 规则匹配（Bash(git *) 语法）
 * 3. ask 交互协调（暴露 decision 供上层 yield permission_request）
 */
export class PermissionManager {
  constructor(
    private readonly mode: PermissionMode,
    private readonly rules: { allow: string[]; ask: string[]; deny: string[] },
  ) {}

  /** 检查单个工具调用的权限 */
  async check(tool: Tool, input: unknown, ctx: ToolContext): Promise<PermissionCheckResult> {
    const result = await checkPermission({
      tool,
      input,
      ctx,
      permissionMode: this.mode,
      rules: this.rules,
    })
    return {
      decision: result.decision,
      reason: result.reason,
    }
  }

  /** 当前模式 */
  getMode(): PermissionMode {
    return this.mode
  }

  /** 是否需要弹窗询问 */
  needsAsk(result: PermissionCheckResult): boolean {
    return result.decision === 'ask'
  }

  /** 是否直接拒绝 */
  isDenied(result: PermissionCheckResult): boolean {
    return result.decision === 'deny'
  }

  /** 是否允许（含 bypassPermissions） */
  isAllowed(result: PermissionCheckResult): boolean {
    return result.decision === 'allow'
  }

  /** 工厂方法：从 config 创建 */
  static fromConfig(config: {
    permissionMode?: PermissionMode
    permissions?: { allow: string[]; ask: string[]; deny: string[] }
  }): PermissionManager {
    return new PermissionManager(
      config.permissionMode ?? 'default',
      config.permissions ?? { allow: [], ask: [], deny: [] },
    )
  }
}
