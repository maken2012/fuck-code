// src/repl/components/DiffViewer.tsx
// v1.18: 结构化 diff 渲染（+ 绿 / - 红，带文件名 + 统计）。
// 接收 DiffEntry[]（来自 diffText 的结构化结果），替代纯 ANSI 文本。
import React from 'react'
import { Box, Text } from 'ink'
import type { DiffEntry } from '@/repl/MessageHistory.js'

export function DiffViewer({ diffs }: { diffs: DiffEntry[] }) {
  return (
    <Box flexDirection="column" marginTop={0}>
      {diffs.map((d, i) => (
        <Box key={i} flexDirection="column" marginBottom={i < diffs.length - 1 ? 1 : 0}>
          <Text color="yellow" bold>{d.file}</Text>
          <Text color="gray" dimColor>{d.stats}</Text>
          <Box flexDirection="column">
            {d.lines.map((l, j) => {
              if (l.type === 'add') return <Text key={j} color="green">{`+ ${l.text}`}</Text>
              if (l.type === 'del') return <Text key={j} color="red">{`- ${l.text}`}</Text>
              return <Text key={j} color="gray">{`  ${l.text}`}</Text>
            })}
          </Box>
        </Box>
      ))}
    </Box>
  )
}
