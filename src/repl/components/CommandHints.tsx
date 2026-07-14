// src/repl/components/CommandHints.tsx
// 实时命令提示组件——输入 / 时在输入框下方显示匹配命令列表。
// 从 Repl.tsx 拆出。
import React from 'react'
import { Box, Text } from 'ink'

export interface CommandHint {
  cmd: string
  desc: string
  args?: string
  example?: string
}

export interface CommandHintsProps {
  hints: CommandHint[]
  selectedIndex: number
  visible: boolean
}

export function CommandHints({ hints, selectedIndex, visible }: CommandHintsProps) {
  if (!visible || hints.length === 0) return null

  const visibleCount = 6
  let startIdx = Math.max(0, selectedIndex - 2)
  const endIdx = Math.min(hints.length, startIdx + visibleCount)
  if (endIdx - startIdx < visibleCount) startIdx = Math.max(0, endIdx - visibleCount)
  const visibleHints = hints.slice(startIdx, endIdx)

  return (
    <Box flexDirection="column" marginTop={0}>
      {startIdx > 0 && <Text dimColor>  ... 上方还有 {startIdx} 条</Text>}
      {visibleHints.map((h) => {
        const realIdx = startIdx + visibleHints.indexOf(h)
        const selected = realIdx === selectedIndex
        return (
          <Box key={h.cmd} flexDirection="column">
            <Text color={selected ? 'yellow' : 'gray'} bold={selected}>
              {selected ? '> ' : '  '}{h.cmd}{h.args ? ` ${h.args}` : ''}
              <Text dimColor>  —  {h.desc}</Text>
            </Text>
            {selected && h.example && (
              <Text dimColor italic>      例：{h.example}</Text>
            )}
          </Box>
        )
      })}
      {endIdx < hints.length && <Text dimColor>  ... 下方还有 {hints.length - endIdx} 条</Text>}
      <Text dimColor>  ↑↓ 选中 · Tab 确认 · Esc 取消（共 {hints.length} 条）</Text>
    </Box>
  )
}
