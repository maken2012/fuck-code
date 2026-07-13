// src/permissions/decision.ts
// 权限决策管线。决策顺序（照计划文档 Task 6）：
//   1. bypassPermissions → allow
//   2. plan + 非只读 → deny
//   3. deny 规则匹配 → deny
//   4. acceptEdits + 非只读 → allow（仍受上面 deny 约束）
//   5. allow 规则匹配 → allow
//   6. （工具内容级 checkPermissions —— M4 暂不实现，跳过）
//   7. ask 规则匹配 → ask
//   8. 默认：只读 allow / 写 ask（fail-safe）
//
// 关键原则：deny 优先级最高（即使 allow/ask 也匹配）；默认宁可多问。
import type { PermissionMode } from '@/permissions/modes.js'
import type { Tool, ToolContext } from '@/tools/Tool.js'
import { matchesRule, parseRule } from '@/permissions/rules.js'

export type PermissionDecision = 'allow' | 'ask' | 'deny'

export interface CheckPermissionOpts {
  tool: Tool
  input: unknown
  ctx: ToolContext
  permissionMode: PermissionMode
  rules: { allow: string[]; ask: string[]; deny: string[] }
}

export interface CheckPermissionResult {
  decision: PermissionDecision
  reason?: string
}

export async function checkPermission(
  opts: CheckPermissionOpts,
): Promise<CheckPermissionResult> {
  const { tool, input, permissionMode, rules } = opts
  const isReadOnly = tool.isReadOnly?.() ?? false
  const toolName = tool.name

  // 1. bypassPermissions：全部放行（最高优先级，沙箱场景）
  if (permissionMode === 'bypassPermissions') {
    return { decision: 'allow', reason: 'bypassPermissions 模式' }
  }

  // 2. plan 模式 + 非只读 → deny（规划模式禁止任何写操作）
  if (permissionMode === 'plan' && !isReadOnly) {
    return {
      decision: 'deny',
      reason: `plan 模式下禁止写操作: ${toolName}`,
    }
  }

  // 3. deny 规则匹配 → deny（最高规则优先级）
  for (const ruleStr of rules.deny) {
    const rule = parseRule(ruleStr)
    if (matchesRule(rule, toolName, input)) {
      return { decision: 'deny', reason: `匹配 deny 规则: ${ruleStr}` }
    }
  }

  // 4. acceptEdits + 非只读 → allow（自动放行编辑，但 deny 已在上面挡过）
  if (permissionMode === 'acceptEdits' && !isReadOnly) {
    return { decision: 'allow', reason: 'acceptEdits 模式' }
  }

  // 5. allow 规则匹配 → allow
  for (const ruleStr of rules.allow) {
    const rule = parseRule(ruleStr)
    if (matchesRule(rule, toolName, input)) {
      return { decision: 'allow', reason: `匹配 allow 规则: ${ruleStr}` }
    }
  }

  // 6. 工具内容级 checkPermissions（M4 暂不实现，跳过）

  // 7. ask 规则匹配 → ask
  for (const ruleStr of rules.ask) {
    const rule = parseRule(ruleStr)
    if (matchesRule(rule, toolName, input)) {
      return { decision: 'ask', reason: `匹配 ask 规则: ${ruleStr}` }
    }
  }

  // 8. 默认：只读 allow / 写 ask（fail-safe）
  if (isReadOnly) {
    return { decision: 'allow', reason: '只读工具默认放行' }
  }
  return { decision: 'ask', reason: '写操作默认询问' }
}
