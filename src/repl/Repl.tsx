// src/repl/Repl.tsx
// M2 REPL：欢迎框 + 输入框 + 流式对话历史。
// 回车把文本喂给 queryLoop，流式累积 assistant 文本。
// Ctrl+C 运行中中断当前轮次，空闲时退出。
import React, { useState, useRef, useEffect } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import type { ChatMessage } from '@/llm/types.js'
import { queryLoop } from '@/agent/queryLoop.js'
import { buildSystemPrompt } from '@/agent/systemPrompt.js'
import { getConfig } from '@/services/runtime.js'

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
  const [running, setRunning] = useState(false)
  const [configLoaded, setConfigLoaded] = useState(false)
  const chatHistoryRef = useRef<ChatMessage[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const configRef = useRef<{
    model: string
    apiKey?: string
    maxTokens: number
  } | null>(null)

  // 启动时读一次 config（异步，失败用默认值）
  useEffect(() => {
    getConfig()
      .then((c) => {
        configRef.current = {
          model: c.value.model,
          apiKey: c.value.apiKey,
          maxTokens: c.value.maxTokens,
        }
      })
      .catch(() => {
        configRef.current = {
          model: 'claude-sonnet-4-5-20250929',
          maxTokens: 8192,
        }
      })
      .finally(() => setConfigLoaded(true))
  }, [])

  async function runQuery(text: string) {
    const config = configRef.current ?? {
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: 8192,
    }
    const ac = new AbortController()
    abortRef.current = ac
    setRunning(true)

    let assistantText = ''
    // 立即新增 user + 空 assistant 两条消息
    setHistory((h) => [
      ...h,
      { role: 'user', text },
      { role: 'assistant', text: '' },
    ])

    try {
      for await (const event of queryLoop({
        history: chatHistoryRef.current,
        userInput: text,
        model: config.model,
        system: buildSystemPrompt(),
        maxTokens: config.maxTokens,
        signal: ac.signal,
        apiKey: config.apiKey,
      })) {
        switch (event.type) {
          case 'text_delta':
            assistantText += event.text
            setHistory((h) => {
              const copy = [...h]
              copy[copy.length - 1] = { role: 'assistant', text: assistantText }
              return copy
            })
            break
          case 'turn_end':
            // 存入真实历史（用于下轮 LLM 上下文）
            chatHistoryRef.current = [
              ...chatHistoryRef.current,
              { role: 'user', content: text },
              { role: 'assistant', content: assistantText },
            ]
            break
          case 'aborted':
            if (assistantText) {
              chatHistoryRef.current = [
                ...chatHistoryRef.current,
                { role: 'user', content: text },
                { role: 'assistant', content: assistantText + ' [已中断]' },
              ]
            }
            break
          case 'error':
            setHistory((h) => {
              const copy = [...h]
              copy[copy.length - 1] = {
                role: 'assistant',
                text: `❌ 错误: ${event.error.message}`,
              }
              return copy
            })
            break
          case 'done':
            break
        }
      }
    } catch (e) {
      setHistory((h) => {
        const copy = [...h]
        copy[copy.length - 1] = {
          role: 'assistant',
          text: `❌ 启动失败: ${String(e)}`,
        }
        return copy
      })
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  useInput((inputChar, key) => {
    // Ctrl+C / Ctrl+D：运行中中断，空闲退出
    if (key.ctrl && (inputChar === 'c' || inputChar === 'd')) {
      if (running && abortRef.current) {
        abortRef.current.abort()
        return
      }
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
      if (text === '/clear') {
        chatHistoryRef.current = []
        setHistory([])
        setInput('')
        return
      }
      if (text && !running) {
        setInput('')
        void runQuery(text)
      }
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
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
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
            {m.role === 'assistant' && m.text === '' && running ? '▋' : ''}
          </Text>
        </Box>
      ))}

      <Box marginTop={1}>
        <Text color="green">❯ </Text>
        <Text>{input}</Text>
        {!running && <Text color="gray">▋</Text>}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {running
            ? '正在生成... Ctrl+C 中断当前轮次'
            : 'Ctrl+C 退出 · 输入 /clear 清空上下文 · /exit 退出'}
        </Text>
      </Box>
    </Box>
  )
}
