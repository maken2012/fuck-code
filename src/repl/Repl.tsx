// src/repl/Repl.tsx
// M2 REPL：欢迎框 + 输入框 + 流式对话历史。
// 回车把文本喂给 queryLoop，流式累积 assistant 文本。
// Ctrl+C 运行中中断当前轮次，空闲时退出。
//
// M4：工具执行前若 queryLoop yield permission_request，渲染权限弹窗，
//   用户按 y/n 后调 resolve('allow'|'deny') 让 queryLoop 继续。
import React, { useState, useRef, useEffect } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import type { ChatMessage } from '@/llm/types.js'
import { queryLoop } from '@/agent/queryLoop.js'
import { buildSystemPrompt } from '@/agent/systemPrompt.js'
import { getAllTools } from '@/tools/registry.js'
import { getConfig } from '@/services/runtime.js'
import type { PermissionMode } from '@/permissions/modes.js'
import type { PermissionUserDecision } from '@/agent/types.js'

export interface ReplProps {
  version?: string
  modelName?: string
}

interface DisplayMessage {
  role: 'user' | 'assistant'
  text: string
}

// M4：权限弹窗的待处理状态。resolve 是 queryLoop 注入的回调，
// 用户回复后调一次 resolve 让 queryLoop 的 await 解除阻塞。
interface PendingPermission {
  tool: string
  summary: string
  resolve: (d: PermissionUserDecision) => void
}

export function Repl({ version = '0.1.0', modelName }: ReplProps) {
  const { exit } = useApp()
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<DisplayMessage[]>([])
  const [running, setRunning] = useState(false)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [pendingPermission, setPendingPermission] =
    useState<PendingPermission | null>(null)
  const chatHistoryRef = useRef<ChatMessage[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const configRef = useRef<{
    model: string
    apiKey?: string
    maxTokens: number
    permissionMode: PermissionMode
    permissions: { allow: string[]; ask: string[]; deny: string[] }
  } | null>(null)
  // 持有 pendingPermission 的最新引用（useInput 闭包读不到 React 最新 state）
  const pendingPermissionRef = useRef<PendingPermission | null>(null)

  // 启动时读一次 config（异步，失败用默认值）
  useEffect(() => {
    getConfig()
      .then((c) => {
        configRef.current = {
          model: c.value.model,
          apiKey: c.value.apiKey,
          maxTokens: c.value.maxTokens,
          permissionMode: c.value.permissionMode,
          permissions: c.value.permissions,
        }
      })
      .catch(() => {
        configRef.current = {
          model: 'claude-sonnet-4-5-20250929',
          maxTokens: 8192,
          permissionMode: 'default',
          permissions: { allow: [], ask: [], deny: [] },
        }
      })
      .finally(() => setConfigLoaded(true))
  }, [])

  async function runQuery(text: string) {
    const config = configRef.current ?? {
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: 8192,
      permissionMode: 'default' as PermissionMode,
      permissions: { allow: [], ask: [], deny: [] },
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
        system: buildSystemPrompt({ tools: getAllTools() }),
        maxTokens: config.maxTokens,
        signal: ac.signal,
        apiKey: config.apiKey,
        cwd: process.cwd(),
        tools: getAllTools(),
        // M4：传权限模式 + 规则给 queryLoop，工具执行前调 checkPermission
        permissionMode: config.permissionMode,
        permissions: config.permissions,
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
          case 'tool_use_start': {
            // 渲染"📖 调用 {tool}"提示（input 截断到 80 字符避免刷屏）
            const inputStr = JSON.stringify(event.input) ?? ''
            const note = `📖 调用 ${event.tool}: ${inputStr.slice(0, 80)}`
            setHistory((h) => [
              ...h,
              { role: 'assistant', text: note },
            ])
            break
          }
          case 'tool_result': {
            const note = event.ok
              ? `✓ ${event.tool} 完成`
              : `✗ ${event.tool} 失败: ${event.content}`
            setHistory((h) => [
              ...h,
              { role: 'assistant', text: note },
            ])
            break
          }
          case 'permission_request': {
            // 设置 pendingPermission 状态：弹窗渲染 + useInput 接管输入等 y/n
            // 同时写 ref（useInput 闭包读 ref，避免 stale state）
            const pending: PendingPermission = {
              tool: event.tool,
              summary: event.inputSummary,
              resolve: event.resolve,
            }
            pendingPermissionRef.current = pending
            setPendingPermission(pending)
            break
          }
          case 'turn_end':
            // 只在最终轮（非 tool_use）把本轮对话存入历史。
            // 工具调用中间轮（stopReason='tool_use'）不存——避免重复 push
            // 和跨轮文本累积污染。queryLoop 内部用完整结构化 messages，
            // Repl 历史只存文本摘要（M2 兼容）。
            if (event.stopReason !== 'tool_use') {
              chatHistoryRef.current = [
                ...chatHistoryRef.current,
                { role: 'user', content: text },
                { role: 'assistant', content: assistantText },
              ]
            }
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
            setHistory((h) => [
              ...h,
              {
                role: 'assistant',
                text: `❌ 错误: ${event.error.message}`,
              },
            ])
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
      // 兜底：异常退出（如 queryLoop 抛错）时若 pendingPermission 残留，
      // resolve('deny') 让任何 await 中的 promise 解除阻塞，避免挂死。
      if (pendingPermissionRef.current) {
        pendingPermissionRef.current.resolve('deny')
        pendingPermissionRef.current = null
        setPendingPermission(null)
      }
    }
  }

  useInput((inputChar, key) => {
    // 权限弹窗激活时接管输入：只接 y/n（大小写都行），其他键忽略。
    // 读 ref 而非 state（useInput 闭包持有的是首次注册时的 state，看不到后续更新）。
    const pending = pendingPermissionRef.current
    if (pending) {
      if (inputChar === 'y' || inputChar === 'Y') {
        pending.resolve('allow')
        pendingPermissionRef.current = null
        setPendingPermission(null)
        return
      }
      if (inputChar === 'n' || inputChar === 'N') {
        pending.resolve('deny')
        pendingPermissionRef.current = null
        setPendingPermission(null)
        return
      }
      // Ctrl+C 在弹窗中视为拒绝（让用户能快速 escape）
      if (key.ctrl && (inputChar === 'c' || inputChar === 'd')) {
        pending.resolve('deny')
        pendingPermissionRef.current = null
        setPendingPermission(null)
        return
      }
      return // 其他键忽略，继续等 y/n
    }
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

      {pendingPermission && (
        <Box
          marginTop={1}
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
        >
          <Text color="yellow" bold>
            ⚠ 权限请求：{pendingPermission.tool} 要执行
          </Text>
          <Text>{pendingPermission.summary.slice(0, 80)}</Text>
          <Text dimColor>允许？[y=允许 / n=拒绝 / Ctrl+C=拒绝]</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {pendingPermission
            ? '等待权限确认...'
            : running
              ? '正在生成... Ctrl+C 中断当前轮次'
              : 'Ctrl+C 退出 · 输入 /clear 清空上下文 · /exit 退出'}
        </Text>
      </Box>
    </Box>
  )
}
