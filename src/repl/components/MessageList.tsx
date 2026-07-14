// src/repl/components/MessageList.tsx
// 消息列表组件——纯渲染，消费 DisplayMessage 数组 + running 状态。
// 从 Repl.tsx 拆出，职责单一。
// 深度比对修复 #4: assistant 消息用 markdown 渲染（代码块高亮 + 列表 + 标题）
// 深度比对第 60 轮: React.memo 优化——流式渲染时已定稿消息不重渲染（对标 Claude Code useDeferredValue）
import React from 'react'
import { Box, Text } from 'ink'
import type { DisplayMessage } from '@/repl/MessageHistory.js'
import { renderMarkdown } from '@/utils/markdown.js'

export interface MessageListProps {
  messages: DisplayMessage[]
  running: boolean
}

// 深度比对第 60 轮: React.memo + 浅比较——流式更新最后一条时，前面的消息不重渲染
function MessageListComponent({ messages, running }: MessageListProps) {
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
        // 工具调用消息（以 [TAG] 开头）
        const isToolCall = /^\s*\[/.test(m.text)
        // 段落分隔标题
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

        // 空消息 + running = 光标占位
        if (m.text === '' && running) {
          return (
            <Box key={i} flexDirection="column">
              <Text color="blue">{'\u258B'}</Text>
            </Box>
          )
        }

        // 流式中（running + 非空）= 原样渲染（markdown 可能不完整，等完成再渲染）
        // 完成后（!running 或下一条消息）= markdown 渲染
        const isStreaming = running && i === messages.length - 1
        const rendered = isStreaming ? m.text : safeRenderMarkdown(m.text)

        return (
          <Box key={i} flexDirection="column">
            <Text>{rendered}</Text>
          </Box>
        )
      })}
    </>
  )
}

// 安全渲染 markdown——出错时回退到原文
function safeRenderMarkdown(text: string): string {
  // 太短或不含 markdown 语法的直接返回（省 CPU）
  if (text.length < 10 || (!text.includes('```') && !text.includes('#') && !text.includes('- ') && !text.includes('**'))) {
    return text
  }
  try {
    return renderMarkdown(text)
  } catch {
    return text
  }
}

// 深度比对第 60 轮: React.memo 导出——浅比较 props，messages 数组引用变才重渲染
export const MessageList = React.memo(MessageListComponent, (prev, next) => {
  // 如果 messages 引用相同 + running 相同 → 跳过重渲染
  if (prev.messages === next.messages && prev.running === next.running) return true
  // 否则重渲染
  return false
})
