// src/repl/components/InputBox.tsx
// 输入框组件——纯渲染，显示当前输入 + 光标。
// 深度比对修复 #1: 支持 cursorOffset 行内编辑
// 深度比对修复 #2: 支持多行输入渲染
import React from 'react'
import { Box, Text } from 'ink'

export interface InputBoxProps {
  input: string
  running: boolean
  visible: boolean
  cursorOffset?: number
}

export function InputBox({ input, running, visible, cursorOffset }: InputBoxProps) {
  if (!visible) return null

  if (running) {
    return (
      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="gray" bold>{'  .. '}</Text>
        <Text color="gray">{input}</Text>
      </Box>
    )
  }

  const offset = cursorOffset ?? input.length
  const hasMultiline = input.includes('\n')

  if (hasMultiline) {
    // 多行渲染：每行一个 Box，光标行高亮
    const lines = input.split('\n')
    let charCount = 0
    return (
      <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="red" paddingX={1}>
        {lines.map((line, lineIdx) => {
          const lineStart = charCount
          charCount += line.length + 1 // +1 for \n
          // 光标在这一行？
          if (offset >= lineStart && offset <= lineStart + line.length) {
            const localOffset = offset - lineStart
            const before = line.slice(0, localOffset)
            const cursorChar = line[localOffset] ?? ''
            const after = line.slice(localOffset + 1)
            return (
              <Box key={lineIdx}>
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
          return (
            <Box key={lineIdx}>
              <Text color="white">{line || ' '}</Text>
            </Box>
          )
        })}
      </Box>
    )
  }

  // 单行渲染（原有逻辑）
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
