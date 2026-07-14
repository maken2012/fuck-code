// src/permissions/rules.ts
// 权限规则解析 + 匹配。
// 深度比对第 27 轮: 支持 Tool(param:value) 参数级匹配（对标 Claude Code）
//
// 规则格式：
//   'Bash(git *)'            → 匹配 Bash 的 command 内容
//   'Edit(file_path:*.env)'  → 匹配 Edit 的 file_path 字段含 .env
//   'Agent(model:opus)'      → 匹配 Agent 的 model 字段是 opus
//   'Read'                   → 匹配所有 Read 调用
//   '*'                      → 匹配所有工具（deny 用）
//
// 匹配逻辑：
//   无参数：只看工具名（支持 * 通配）
//   有参数名（param:value）：精确匹配 input 的指定字段
//   有内容但无参数名：匹配 input 的关键字段（command/file_path/pattern）

export interface PermissionRule {
  tool: string                  // 工具名（支持 * 通配）
  param?: string                // 参数级匹配的字段名（深度比对第 27 轮）
  contentPattern?: string       // 内容匹配模式（含 * 通配符）
}

// 解析规则字符串
export function parseRule(rule: string): PermissionRule {
  const trimmed = rule.trim()

  // 纯通配符 '*'（匹配所有工具）
  if (trimmed === '*') return { tool: '*' }

  const open = trimmed.indexOf('(')
  if (open === -1) {
    return { tool: trimmed }
  }
  const tool = trimmed.slice(0, open)
  const lastClose = trimmed.lastIndexOf(')')
  const content = lastClose > open ? trimmed.slice(open + 1, lastClose) : trimmed.slice(open + 1)
  if (content === '') return { tool }

  // 深度比对第 27 轮: 检测 Tool(param:value) 参数级语法
  const colonIdx = content.indexOf(':')
  if (colonIdx > 0) {
    const param = content.slice(0, colonIdx).trim()
    const value = content.slice(colonIdx + 1).trim()
    // 确认 param 是合法字段名（字母+下划线，非通配符模式开头）
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(param)) {
      return { tool, param, contentPattern: value }
    }
  }

  return { tool, contentPattern: content }
}

// 匹配规则
export function matchesRule(
  rule: PermissionRule,
  toolName: string,
  input: unknown,
): boolean {
  // 深度比对第 27 轮: 工具名支持 * 通配
  if (rule.tool === '*') {
    // * 匹配所有工具——但如果有 contentPattern 仍需检查
  } else if (rule.tool !== toolName) {
    return false
  }

  if (rule.contentPattern === undefined && rule.param === undefined) {
    return true // 无条件匹配（只看工具名）
  }

  // 深度比对第 27 轮: 参数级匹配 Tool(param:value)
  if (rule.param) {
    if (typeof input !== 'object' || input === null) return false
    const obj = input as Record<string, unknown>
    const fieldValue = obj[rule.param]
    if (typeof fieldValue !== 'string') return false
    return wildcardMatch(rule.contentPattern ?? '*', fieldValue)
  }

  // 内容匹配（原有逻辑）
  const fieldValue = extractContentField(rule.tool === '*' ? toolName : rule.tool, input)
  if (fieldValue === undefined) return false
  return wildcardMatch(rule.contentPattern!, fieldValue)
}

// 按工具名取默认内容字段
function extractContentField(toolName: string, input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const obj = input as Record<string, unknown>
  if (toolName === 'Bash') {
    const v = obj['command']
    return typeof v === 'string' ? v : undefined
  }
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') {
    const v = obj['file_path']
    return typeof v === 'string' ? v : undefined
  }
  if (toolName === 'Grep' || toolName === 'Glob') {
    const v = obj['pattern']
    return typeof v === 'string' ? v : undefined
  }
  return undefined
}

// 深度比对第 52 轮: 规则编译缓存（对标 Claude Code 'rule matchers are now compiled once and cached'）
// wildcardMatch 每次 new RegExp 很贵——编译一次缓存
const regexCache = new Map<string, RegExp>()

function getCompiledRegex(pattern: string): RegExp {
  let re = regexCache.get(pattern)
  if (!re) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    re = new RegExp(`^${escaped}$`)
    regexCache.set(pattern, re)
  }
  return re
}

// 深度比对第 52 轮: shadowed rule 检测（对标 Claude Code shadowedRuleDetection）
// 启动时检测 allow/ask/deny 里的冗余规则（被更高优先级规则完全覆盖）
export function detectShadowedRules(rules: {
  allow: string[]
  ask: string[]
  deny: string[]
}): string[] {
  const warnings: string[] = []
  const parsedDeny = rules.deny.map(parseRule)
  const parsedAllow = rules.allow.map(parseRule)
  const parsedAsk = rules.ask.map(parseRule)

  // deny 规则里的 shadow：A 比 B 更宽泛且都在 deny → B 被 shadow
  for (let i = 0; i < parsedDeny.length; i++) {
    for (let j = 0; j < parsedDeny.length; j++) {
      if (i === j) continue
      const a = parsedDeny[i]!
      const b = parsedDeny[j]!
      // a 完全覆盖 b（同工具 + a 的 pattern 更宽泛）
      if (a.tool === b.tool && a.contentPattern && b.contentPattern &&
          a.contentPattern !== b.contentPattern &&
          getCompiledRegex(a.contentPattern).test('')) {
        // a 含 * 匹配一切 → b 被 shadow
        if (a.contentPattern === '*' || a.contentPattern === '**') {
          warnings.push(`deny 规则 "${rules.deny[j]}" 被 "${rules.deny[i]}" 覆盖`)
        }
      }
    }
  }

  // allow 规则被 deny 覆盖
  for (const a of parsedAllow) {
    for (const d of parsedDeny) {
      if (a.tool === d.tool && !d.contentPattern && !d.param) {
        // deny 整个工具 → allow 该工具的任何子规则都无效
        warnings.push(`allow 规则 "/${a.tool}" 被 deny "${d.tool}" 完全覆盖`)
        break
      }
    }
  }

  return warnings
}

// 通配符匹配（使用编译缓存）
export function wildcardMatch(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) {
    return pattern === value
  }
  return getCompiledRegex(pattern).test(value)
}
