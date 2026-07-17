// src/repl/components/StatusBar.tsx
// 底部状态栏组件——显示模型/token/暴躁文案。
// 从 Repl.tsx 拆出。
import React from 'react'
import { Box, Text } from 'ink'
import { attitudeFor } from '@/personality.js'

export interface StatusBarProps {
  running: boolean
  pendingPermission: boolean
  model: string
  totalTokens: { input: number; output: number; cacheRead: number }
  idleAttitude: string
  genAttitude: string
  /** v1.19: 子 agent（Task）描述列表——有值时状态栏显示"子 agent 在探索 xxx" */
  subagentDescs?: string[]
}

export function StatusBar({ running, pendingPermission, model, totalTokens, idleAttitude, genAttitude, subagentDescs }: StatusBarProps) {
  // v1.19: 子 agent 在跑时优先显示（比纯 running 更具体）
  const subagentStatus = subagentDescs && subagentDescs.length > 0
    ? `⚡ 子 agent(${subagentDescs.length}): ${subagentDescs.slice(0, 2).join('、')}${subagentDescs.length > 2 ? '…' : ''} [Ctrl+C 中断]`
    : null
  return (
    <Box marginTop={0}>
      <Text dimColor>
        {pendingPermission
          ? attitudeFor('permission')
          : subagentStatus
            ? subagentStatus
            : running
              ? `${genAttitude} [Ctrl+C 中断]`
              : `${model} · ${totalTokens.input + totalTokens.output} tok · Alt+Enter 换行 · ${idleAttitude}`}
      </Text>
    </Box>
  )
}
