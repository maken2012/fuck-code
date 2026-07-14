// src/repl/components/InputBox.tsx
// 输入框组件——纯渲染，显示当前输入 + 光标。
// 从 Repl.tsx 拆出。
import React from 'react'
import { Box, Text } from 'ink'

export interface InputBoxProps {
  input: string
  running: boolean
  visible: boolean
}

export function InputBox({ input, running, visible }: InputBoxProps) {
  if (!visible) return null
  return (
    <Box marginTop={1} borderStyle="single" borderColor={running ? 'gray' : 'red'} paddingX={1}>
      <Text color={running ? 'gray' : 'yellow'} bold>{running ? '  .. ' : '> '}</Text>
      <Text color={running ? 'gray' : 'white'}>{input}</Text>
      {!running && <Text color="red">{'\u258B'}</Text>}
    </Box>
  )
}
