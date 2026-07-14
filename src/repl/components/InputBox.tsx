// src/repl/components/InputBox.tsx
// 输入框组件——纯渲染，显示当前输入 + 光标。
// 深度比对修复 #1: 支持 cursorOffset——光标在行内任意位置，按 offset 拆三段渲染。
import React from 'react'
import { Box, Text } from 'ink'

export interface InputBoxProps {
  input: string
  running: boolean
  visible: boolean
  cursorOffset?: number // 光标位置（默认 = input.length，即在末尾）
}

export function InputBox({ input, running, visible, cursorOffset }: InputBoxProps) {
  if (!visible) return null

  // running 时光标固定在末尾
  if (running) {
    return (
      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="gray" bold>{'  .. '}</Text>
        <Text color="gray">{input}</Text>
      </Box>
    )
  }

  // 深度比对 #1: 按 cursorOffset 拆三段 [before][cursorChar][after]
  const offset = cursorOffset ?? input.length
  const before = input.slice(0, offset)
  const cursorChar = input[offset] ?? ''
  const after = input.slice(offset + 1)

  return (
    <Box marginTop={1} borderStyle="single" borderColor="red" paddingX={1}>
      <Text color="yellow" bold>{'> '}</Text>
      <Text color="white">{before}</Text>
      {cursorChar ? (
        <Text color="black" backgroundColor="red" bold>{cursorChar}</Text>
      ) : (
        <Text color="red">{'\u258B'}</Text>
      )}
      <Text color="white">{after}</Text>
    </Box>
  )
}
