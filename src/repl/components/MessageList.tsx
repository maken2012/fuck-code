// src/repl/components/MessageList.tsx
// 消息列表组件——纯渲染，消费 DisplayMessage 数组 + running 状态。
// 从 Repl.tsx 拆出，职责单一。
import React from 'react'
import { Box, Text } from 'ink'
import type { DisplayMessage } from '@/repl/MessageHistory.js'
import { toolTag, STATUS } from '@/personality.js'

export interface MessageListProps {
  messages: DisplayMessage[]
  running: boolean
}

export function MessageList({ messages, running }: MessageListProps) {
  return (
    <>
      {messages.map((m, i) => {
        if (m.role === 'user') {
          return (
            <Box key={i} marginTop={i === 0 ? 1 : 0}>
              <Text color="green" bold>{'> '}</Text>
              <Text color="green">{m.text}</Text>
            </Box>
          )
        }
        const isToolCall = /^\s*\[/.test(m.text)
        const isSectionHeader = /^---|齐活了|目标算是/.test(m.text)
        if (isToolCall) {
          return (
            <Box key={i} flexDirection="column" marginLeft={2}>
              <Text dimColor>{m.text}</Text>
            </Box>
          )
        }
        if (isSectionHeader) {
          return (
            <Box key={i} marginTop={1}>
              <Text color="yellow" bold>{m.text}</Text>
            </Box>
          )
        }
        return (
          <Box key={i} flexDirection="column">
            <Text color={m.text === '' && running ? 'blue' : 'white'}>
              {m.text}
              {m.text === '' && running ? <Text color="blue">{'\u258B'}</Text> : ''}
            </Text>
          </Box>
        )
      })}
    </>
  )
}
