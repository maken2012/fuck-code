// src/repl/components/TokenDashboard.tsx
// v1.18: token 占用可视化（条形图）。
// 把 user/assistant/toolResult 三类 token 画成进度条 + 占比。
import React from 'react'
import { Box, Text } from 'ink'
import type { TokenBreakdown } from '@/repl/MessageHistory.js'

function bar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width)
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

export function TokenDashboard({ tokens }: { tokens: TokenBreakdown }) {
  const { total, contextWindow, user, assistant, toolResult } = tokens
  const overallPct = Math.round((total / contextWindow) * 100)
  const userPct = total > 0 ? Math.round((user / total) * 100) : 0
  const asstPct = total > 0 ? Math.round((assistant / total) * 100) : 0
  const toolPct = total > 0 ? Math.round((toolResult / total) * 100) : 0

  const overallColor = overallPct > 80 ? 'red' : overallPct > 50 ? 'yellow' : 'green'

  return (
    <Box flexDirection="column">
      <Text color={overallColor} bold>
        {`上下文 ${bar(overallPct)} ${overallPct}%  (${total} / ${contextWindow} tokens)`}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="green">{`用户输入   ${bar(userPct, 15)} ${userPct}%  (${user} tokens)`}</Text>
        <Text color="cyan">{`模型回复   ${bar(asstPct, 15)} ${asstPct}%  (${assistant} tokens)`}</Text>
        <Text color="magenta">{`工具结果   ${bar(toolPct, 15)} ${toolPct}%  (${toolResult} tokens)`}</Text>
      </Box>
    </Box>
  )
}
