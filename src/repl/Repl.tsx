// src/repl/Repl.tsx
// M1 极简 REPL：欢迎语 + 输入框 + 回显历史。
// M2 会把 onSubmit 接到 queryLoop。
import React, { useState } from 'react'
import { Box, Text, useInput, useApp } from 'ink'

export interface ReplProps {
  version?: string
  modelName?: string
}

interface DisplayMessage {
  role: 'user' | 'assistant'
  text: string
}

export function Repl({ version = '0.1.0', modelName }: ReplProps) {
  const { exit } = useApp()
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<DisplayMessage[]>([])

  useInput((inputChar, key) => {
    // Ctrl+C / Ctrl+D 退出
    if (key.ctrl && (inputChar === 'c' || inputChar === 'd')) {
      exit()
      return
    }
    // 回车提交
    if (key.return) {
      const text = input.trim()
      if (text === '/exit' || text === '/quit') {
        exit()
        return
      }
      if (text) {
        setHistory((h) => [...h, { role: 'user', text }])
        // M2: 这里会 await runQueryLoop(text, ...)
        // M1: 只回显
        setHistory((h) => [
          ...h,
          {
            role: 'assistant',
            text: `（M1 骨架模式：你说了 "${text}"，模型接入在 M2）`,
          },
        ])
      }
      setInput('')
      return
    }
    // 退格
    if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1))
      return
    }
    // 普通字符（忽略 ctrl/meta 组合）
    if (!key.ctrl && !key.meta && inputChar && inputChar.length === 1) {
      setInput((s) => s + inputChar)
    }
  })

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
      >
        <Text bold color="cyan">
          fuckcode <Text dimColor>v{version}</Text>
        </Text>
        {modelName && <Text dimColor>模型: {modelName}</Text>}
        <Text dimColor>原生中文交互的终端 AI 编码工具</Text>
      </Box>

      {history.map((m, i) => (
        <Box key={i} flexDirection="column">
          <Text color={m.role === 'user' ? 'green' : 'blue'}>
            {m.role === 'user' ? '你' : 'fuckcode'}: {m.text}
          </Text>
        </Box>
      ))}

      <Box marginTop={1}>
        <Text color="green">❯ </Text>
        <Text>{input}</Text>
        <Text color="gray">▋</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Ctrl+C / Ctrl+D 退出 · 输入 /exit 退出 · M2 将接入模型</Text>
      </Box>
    </Box>
  )
}
