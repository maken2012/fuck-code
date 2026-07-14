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
}

export function StatusBar({ running, pendingPermission, model, totalTokens, idleAttitude, genAttitude }: StatusBarProps) {
  return (
    <Box marginTop={0}>
      <Text dimColor>
        {pendingPermission
          ? attitudeFor('permission')
          : running
            ? `${genAttitude} [Ctrl+C 中断]`
            : `${model} · ${totalTokens.input + totalTokens.output} tok · ${idleAttitude}`}
      </Text>
    </Box>
  )
}
