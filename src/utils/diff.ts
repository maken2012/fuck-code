// src/utils/diff.ts
// 极简行 diff 工具。生成两段文本间的 unified diff（类似 git diff 格式）。
// 用 Myers 算法的简化版（LCS）。不引入额外依赖。
// 用于：/diff 命令（查看本会话改动）、Edit 结果美化。

export interface DiffLine {
  type: 'add' | 'del' | 'ctx'  // + / - / 空格
  text: string
  oldNum?: number
  newNum?: number
}

// 计算两段文本的 diff（按行）
export function diffText(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  // LCS 动态规划
  const m = oldLines.length
  const n = newLines.length
  // 优化：只保留两行（滚动数组算长度），但回溯需要完整表。对小文件（<500行）直接全表。
  if (m > 500 || n > 500) {
    // 大文件降级：直接显示新内容（不做精确 diff）
    return newLines.map((line, i) => ({ type: 'add' as const, text: line, newNum: i + 1 }))
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
      }
    }
  }
  // 回溯
  const result: DiffLine[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: 'ctx', text: oldLines[i - 1]!, oldNum: i, newNum: j })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.unshift({ type: 'add', text: newLines[j - 1]!, newNum: j })
      j--
    } else {
      result.unshift({ type: 'del', text: oldLines[i - 1]!, oldNum: i })
      i--
    }
  }
  return result
}

// 格式化 diff 为可读字符串（+ 绿 / - 红，用 ANSI 颜色）
export function formatDiff(diff: DiffLine[], contextLines = 3): string {
  // 只显示变更行周围 contextLines 行上下文
  const changeIdx = new Set<number>()
  diff.forEach((l, i) => {
    if (l.type !== 'ctx') {
      for (let k = Math.max(0, i - contextLines); k <= Math.min(diff.length - 1, i + contextLines); k++) {
        changeIdx.add(k)
      }
    }
  })
  const visible = diff.filter((_, i) => changeIdx.has(i))
  return visible
    .map((l) => {
      const num = l.oldNum ?? l.newNum ?? 0
      const numStr = String(num).padStart(4, ' ')
      if (l.type === 'add') return `\x1b[32m+ ${numStr} ${l.text}\x1b[0m`
      if (l.type === 'del') return `\x1b[31m- ${numStr} ${l.text}\x1b[0m`
      return `  ${numStr} ${l.text}`
    })
    .join('\n')
}
