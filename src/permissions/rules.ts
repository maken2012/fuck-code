// src/permissions/rules.ts
// 权限规则解析 + 匹配。规则字符串格式：ToolName(content?)。
//   'Bash(git *)'  → { tool: 'Bash', contentPattern: 'git *' }
//   'Read'         → { tool: 'Read' }
//
// matchesRule：工具名全等 +（如有 contentPattern）针对 input 的关键字段做通配符匹配。
//   - Bash 匹配 input.command
//   - Edit/Write 匹配 input.file_path
// 通配符：含 '*' 时按 glob 转 regex（* → .*，其他字符按字面转义）；否则全等。
// 不引入新依赖，自己写最小匹配。

export interface PermissionRule {
  tool: string
  contentPattern?: string // 可选，含 * 通配符
}

// 解析 'Bash(git *)' / 'Read' / 'Edit(src/**)' / 'Bash()'（空括号视为无 pattern）
export function parseRule(rule: string): PermissionRule {
  const trimmed = rule.trim()
  const open = trimmed.indexOf('(')
  if (open === -1) {
    return { tool: trimmed }
  }
  const tool = trimmed.slice(0, open)
  // 取最后一个 ')' 之前的部分作为 content（防止 content 里含 ')'）
  const lastClose = trimmed.lastIndexOf(')')
  const content = lastClose > open ? trimmed.slice(open + 1, lastClose) : trimmed.slice(open + 1)
  if (content === '') return { tool }
  return { tool, contentPattern: content }
}

// tool 名匹配 +（如有 contentPattern）input 字段匹配
export function matchesRule(
  rule: PermissionRule,
  toolName: string,
  input: unknown,
): boolean {
  if (rule.tool !== toolName) return false
  if (rule.contentPattern === undefined) return true // 无 contentPattern 只看 tool 名
  // 取 input 的内容字段
  const fieldValue = extractContentField(rule.tool, input)
  if (fieldValue === undefined) return false
  return wildcardMatch(rule.contentPattern, fieldValue)
}

// 按工具名取内容字段：Bash→command；Edit/Write→file_path；其他工具无内容字段（undefined）
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
  return undefined
}

// 通配符匹配：含 '*' 时 * → .*（其他字符字面转义）；否则全等。
// 支持的最小语义：单 * 匹配任意字符序列。'**' 与 '*' 等价（简化，不做路径感知）。
export function wildcardMatch(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) {
    return pattern === value
  }
  // 转义 regex 特殊字符，再把转义后的 '*' 还原成 '.*'
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  const re = new RegExp(`^${escaped}$`)
  return re.test(value)
}
