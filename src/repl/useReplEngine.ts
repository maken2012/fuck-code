// src/repl/useReplEngine.ts
// Repl 核心引擎 hook。把 Repl 组件的 31 个状态/函数抽成可复用的 hook。
// Repl.tsx 变成纯渲染组件，只消费 hook 返回的状态和回调。
//
// 职责分离：
// - useReplEngine: 状态管理 + 业务逻辑（对话/工具/会话/配置）
// - Repl.tsx: 纯 UI 渲染（消费 hook 返回的值）
// - CommandRegistry: 命令注册/执行
// - MessageHistory: 对话历史管理
import { useState, useRef, useEffect, useCallback } from 'react'
import type { ChatMessage } from '@/llm/types.js'
import { MessageHistory } from '@/repl/MessageHistory.js'
import type { DisplayMessage } from '@/repl/MessageHistory.js'
import type { PermissionMode } from '@/permissions/modes.js'
import { getConfig } from '@/services/runtime.js'
import { createSession } from '@/services/Session.js'
import { loadPromptHistory, appendPromptHistory } from '@/services/PromptHistory.js'
import { attitudeFor } from '@/personality.js'

export interface ReplEngineState {
  // 状态
  input: string
  setInput: (s: string) => void
  history: DisplayMessage[]
  running: boolean
  currentModel: string
  setCurrentModel: (m: string) => void
  totalTokens: { input: number; output: number; cacheRead: number }
  config: React.MutableRefObject<{
    model: string
    apiKey?: string
    apiBaseUrl?: string
    provider?: 'anthropic' | 'openai' | 'openai-compatible'
    fallbackModels?: string[]
    maxTokens: number
    contextWindow: number
    permissionMode: PermissionMode
    permissions: { allow: string[]; ask: string[]; deny: string[] }
  } | null>
  sessionId: string | null

  // 历史
  inputHistory: React.MutableRefObject<string[]>
  historyIndex: React.MutableRefObject<number>
  chatHistory: React.MutableRefObject<ChatMessage[]>
  historyManager: MessageHistory

  // 控制
  abortRef: React.MutableRefObject<AbortController | null>
  idleAttitude: string
  genAttitude: string

  // 操作
  setHistory: (h: DisplayMessage[]) => void
  appendHistory: (m: DisplayMessage) => void
  updateLastAssistant: (text: string) => void
  addTokens: (t: { input: number; output: number; cacheRead: number }) => void
  recordTurn: (userInput: string, assistantResponse: string) => void
  startRunning: () => void
  stopRunning: () => void
  abort: () => void
  saveInputHistory: (text: string) => void
}

export function useReplEngine(initialModel?: string): ReplEngineState {
  const [input, setInput] = useState('')
  const [currentModel, setCurrentModel] = useState(initialModel ?? 'claude-sonnet-4-5-20250929')
  const [running, setRunning] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)

  const historyManager = useRef(new MessageHistory()).current
  const [history, setHistoryState] = useState<DisplayMessage[]>([])

  const inputHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  const chatHistoryRef = useRef<ChatMessage[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const totalTokensRef = useRef({ input: 0, output: 0, cacheRead: 0 })
  const idleAttitudeRef = useRef(attitudeFor('idle'))
  const genAttitudeRef = useRef(attitudeFor('generating'))

  const configRef = useRef<{
    model: string
    apiKey?: string
    apiBaseUrl?: string
    provider?: 'anthropic' | 'openai' | 'openai-compatible'
    fallbackModels?: string[]
    maxTokens: number
    contextWindow: number
    permissionMode: PermissionMode
    permissions: { allow: string[]; ask: string[]; deny: string[] }
  } | null>(null)

  // 初始化：加载 config + 创建 session + 加载历史
  useEffect(() => {
    getConfig()
      .then((c) => {
        configRef.current = {
          model: initialModel ?? c.value.model,
          apiKey: c.value.apiKey,
          apiBaseUrl: c.value.apiBaseUrl,
          provider: c.value.provider,
          fallbackModels: c.value.fallbackModels,
          maxTokens: c.value.maxTokens,
          contextWindow: c.value.contextWindow,
          permissionMode: c.value.permissionMode,
          permissions: c.value.permissions,
        }
      })
      .catch(() => {
        configRef.current = {
          model: initialModel ?? 'claude-sonnet-4-5-20250929',
          maxTokens: 8192,
          contextWindow: 200000,
          permissionMode: 'default' as const,
          permissions: { allow: [], ask: [], deny: [] },
        }
      })

    createSession(process.cwd()).then(setSessionId).catch(() => {})

    loadPromptHistory(process.cwd())
      .then((hist) => { inputHistoryRef.current = hist.slice().reverse() })
      .catch(() => {})
  }, [initialModel])

  // 状态切换时刷新暴躁文案
  useEffect(() => {
    if (running) genAttitudeRef.current = attitudeFor('generating')
    else idleAttitudeRef.current = attitudeFor('idle')
  }, [running])

  // 封装 setHistory（同步到 historyManager）
  const setHistory = useCallback((h: DisplayMessage[]) => {
    historyManager.setDisplay(h)
    setHistoryState(h)
  }, [historyManager])

  const appendHistory = useCallback((m: DisplayMessage) => {
    historyManager.appendDisplay(m)
    setHistoryState(historyManager.getDisplay())
  }, [historyManager])

  const updateLastAssistant = useCallback((text: string) => {
    historyManager.updateLastAssistant(text)
    setHistoryState(historyManager.getDisplay())
  }, [historyManager])

  const addTokens = useCallback((t: { input: number; output: number; cacheRead: number }) => {
    totalTokensRef.current.input += t.input
    totalTokensRef.current.output += t.output
    totalTokensRef.current.cacheRead += t.cacheRead
  }, [])

  const recordTurn = useCallback((userInput: string, assistantResponse: string) => {
    historyManager.recordTurn(userInput, assistantResponse)
    chatHistoryRef.current = historyManager.getChat()
  }, [historyManager])

  const startRunning = useCallback(() => setRunning(true), [])
  const stopRunning = useCallback(() => setRunning(false), [])
  const abort = useCallback(() => {
    if (abortRef.current) abortRef.current.abort()
  }, [])

  const saveInputHistory = useCallback((text: string) => {
    const hist = inputHistoryRef.current
    if (hist[hist.length - 1] !== text) {
      hist.push(text)
      if (hist.length > 100) hist.shift()
      void appendPromptHistory(process.cwd(), text).catch(() => {})
    }
    historyIndexRef.current = -1
  }, [])

  return {
    input, setInput,
    history, setHistory, appendHistory, updateLastAssistant,
    running, startRunning, stopRunning, abort,
    currentModel, setCurrentModel,
    totalTokens: totalTokensRef.current,
    config: configRef,
    sessionId,
    inputHistory: inputHistoryRef,
    historyIndex: historyIndexRef,
    chatHistory: chatHistoryRef,
    historyManager,
    abortRef,
    idleAttitude: idleAttitudeRef.current,
    genAttitude: genAttitudeRef.current,
    addTokens,
    recordTurn,
    saveInputHistory,
  }
}
