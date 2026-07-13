# fuckcode M2 LLM + 基础 loop 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 REPL 接入 Anthropic Claude，实现多轮纯文本对话——输入文字后流式显示模型回复，支持多轮上下文（保留历史 messages），Ctrl+C 可中断当前轮次。**不含工具调用**（M3 才加）。

**Architecture:** 新增 LLM 层：`src/llm/anthropic.ts` 用 `@anthropic-ai/sdk` 的 `messages.create({stream:true})` 封装 async generator（照搬 Claude Code 模式：不用 MessageStream helper，自己累积 block）。新增 `src/agent/queryLoop.ts` 作为主循环 async generator（无工具版：发请求→流式 yield→存历史→结束）。Repl.tsx 改造：回车后跑 queryLoop，把 text_delta 实时渲染。

**Tech Stack:** 复用 M1 全部栈 + `@anthropic-ai/sdk@0.111.0`（已在 package.json）

**前置依赖：**
- ✅ M1 完成（16 tests PASS，分支 feat/m1-skeleton）
- ✅ `@anthropic-ai/sdk` 已装
- ⚠️ **需要 `ANTHROPIC_API_KEY` 环境变量**才能真实调用（E2E 验证时）

**关键设计决策（来自 Claude Code 逆向）：**
1. 用 `messages.create({stream:true})` 而非 `messages.stream()`（避免 O(n²) JSON 解析，M3 加工具时无缝）
2. content_block_start 时强制清空 text（SDK 会重复发同样内容）
3. input_tokens 只从 message_start 拿，output_tokens 只从 message_delta 拿（避免覆盖）
4. AbortController 在 queryLoop 层创建，signal 传给 SDK 的第二参数 RequestOptions
5. system prompt 用字符串（M2 不做 prompt cache，M6 再加）

---

## 文件结构（本计划产出）

```
fuck-code/
├── src/
│   ├── llm/
│   │   ├── anthropic.ts          # Task 1 — Anthropic 流式 async generator
│   │   └── types.ts              # Task 1 — LLM 事件类型（LlmEvent）
│   ├── agent/
│   │   ├── queryLoop.ts          # Task 2 — 主循环（无工具版）
│   │   ├── systemPrompt.ts       # Task 3 — 中文 system prompt
│   │   └── types.ts              # Task 2 — QueryEvent 类型
│   └── repl/
│       └── Repl.tsx              # Task 4 — 改造（接入 queryLoop + 流式渲染）
├── tests/
│   ├── llm/
│   │   └── anthropic.test.ts     # Task 1 — mock SDK 验证事件解析
│   └── agent/
│       └── queryLoop.test.ts     # Task 2 — mock LLM 验证循环逻辑
```

**职责划分：**
- `llm/types.ts`：LLM 层事件契约（text/usage/done），与 provider 无关
- `llm/anthropic.ts`：Anthropic provider 实现，把 SDK 事件流转成 LlmEvent
- `agent/types.ts`：queryLoop 的 QueryEvent 契约（TUI 消费）
- `agent/queryLoop.ts`：主循环，调 llm + 管理历史 messages
- `agent/systemPrompt.ts`：中文 system prompt（M2 基础版）
- `repl/Repl.tsx`：改造 onSubmit 接 queryLoop

---

## Task 1: src/llm/types.ts + src/llm/anthropic.ts（流式 generator + 测试）

### Step 1: 写 src/llm/types.ts

```typescript
// src/llm/types.ts
// LLM 层事件契约。与具体 provider 无关（M2 只有 Anthropic，但保持抽象便于 M3+ 扩展）。

// 一条对话消息（Anthropic API 兼容格式）
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

// 流式事件：queryLoop 和 TUI 消费这些事件
export type LlmEvent =
  | { type: 'text'; textDelta: string }           // 文本片段
  | { type: 'usage'; input: number; output: number; cacheRead: number }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; error: Error }

// 单次流式调用的结果（done 时的汇总）
export interface LlmResult {
  text: string
  stopReason: string
  usage: { input: number; output: number; cacheRead: number }
}
```

- [ ] **Step 1: 写 src/llm/types.ts**（如上）

### Step 2: 写测试 tests/llm/anthropic.test.ts（mock SDK）

测试策略：mock `@anthropic-ai/sdk` 的 `messages.create`，让它返回预录制的异步事件流，验证我们的 generator 正确解析。

```typescript
// tests/llm/anthropic.test.ts
import { test, expect, mock, beforeEach } from 'bun:test'

// mock @anthropic-ai/sdk —— 在 import anthropic 之前 patch
const mockCreate = mock(() => {})
beforeEach(() => mockCreate.mockClear())

// 用动态 import 让 mock 生效后再加载被测模块
const { streamAnthropic } = await import('@/llm/anthropic.js')

// 构造一个假的 async iterable，模拟 SDK 的 stream
function fakeStream(events: object[]): AsyncIterable<object> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
    },
  }
}

test('解析纯文本流式响应', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '不该出现' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '世界' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ]
  mockCreate.mockReturnValue(fakeStream(events))

  const out: { type: string; textDelta?: string }[] = []
  for await (const e of streamAnthropic({
    model: 'claude-sonnet-4-5-20250929',
    system: 'test',
    messages: [{ role: 'user', content: 'hi' }],
    signal: new AbortController().signal,
    _clientOverride: { messages: { create: mockCreate } } as any,
  })) {
    out.push(e as any)
  }

  // 应有两个 text 事件 + 一个 usage + 一个 done
  const texts = out.filter((e) => e.type === 'text')
  expect(texts.length).toBe(2)
  expect((texts[0] as any).textDelta).toBe('你好')
  expect((texts[1] as any).textDelta).toBe('世界')

  const usage = out.find((e) => e.type === 'usage') as any
  expect(usage.input).toBe(10)
  expect(usage.cacheRead).toBe(5)
  expect(usage.output).toBe(20) // 来自 message_delta

  const done = out.find((e) => e.type === 'done') as any
  expect(done.stopReason).toBe('end_turn')
})

test('content_block_start 的 text 不重复输出', async () => {
  // SDK 会在 content_block_start 发一遍 text，然后 delta 又发——我们应只输出 delta 的
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '完整文本' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完整文本' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  mockCreate.mockReturnValue(fakeStream(events))

  const texts: string[] = []
  for await (const e of streamAnthropic({
    model: 'm',
    system: 's',
    messages: [],
    signal: new AbortController().signal,
    _clientOverride: { messages: { create: mockCreate } } as any,
  })) {
    if (e.type === 'text') texts.push((e as any).textDelta)
  }
  expect(texts).toEqual(['完整文本']) // 只一次，不是两次
})

test('abort 时抛 AbortError', async () => {
  const ac = new AbortController()
  mockCreate.mockReturnValue(fakeStream([
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '部分' } },
  ]))
  // 立即 abort
  ac.abort()
  await expect(async () => {
    for await (const _ of streamAnthropic({
      model: 'm',
      system: 's',
      messages: [],
      signal: ac.signal,
      _clientOverride: { messages: { create: mockCreate } } as any,
    })) {
      // drain
    }
  }).rejects.toThrow(/abort/i)
})
```

- [ ] **Step 2: 写测试 tests/llm/anthropic.test.ts**

- [ ] **Step 3: 跑测试确认失败**（红）

Run: `bun test tests/llm/anthropic.test.ts`
Expected: FAIL — `Cannot find module '@/llm/anthropic.js'`

### Step 4: 写实现 src/llm/anthropic.ts

```typescript
// src/llm/anthropic.ts
// Anthropic 流式调用封装。照搬 Claude Code 模式：
// - 用 messages.create({stream:true}) 而非 messages.stream()（避免 O(n²) JSON 解析）
// - 自己累积 block 状态，不用 SDK 的 MessageStream helper
// - content_block_start 强制清空 text（SDK 会重复发）
// - input_tokens 只取 message_start，output_tokens 只取 message_delta
import Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage, LlmEvent } from '@/llm/types.js'

export interface StreamAnthropicOpts {
  model: string
  system: string
  messages: ChatMessage[]
  maxTokens?: number
  signal: AbortSignal
  apiKey?: string
  // 测试用：注入 mock client（生产代码不传）
  _clientOverride?: { messages: { create: (body: object, opts?: object) => AsyncIterable<object> } }
}

export async function* streamAnthropic(opts: StreamAnthropicOpts): AsyncGenerator<LlmEvent> {
  // 构造 client（测试时用 override）
  const client = opts._clientOverride ?? new Anthropic({ apiKey: opts.apiKey })

  let stream: AsyncIterable<object>
  try {
    // 注：用 any 绕过 SDK 类型（mock client 签名不同），生产路径 client.messages.create 类型正确
    stream = await (client as any).messages.create(
      {
        model: opts.model,
        max_tokens: opts.maxTokens ?? 8192,
        system: opts.system,
        messages: opts.messages,
        stream: true,
      },
      { signal: opts.signal },
    )
  } catch (e) {
    if (opts.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    throw e
  }

  // 自己累积 block 状态（Claude Code 风格）
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let stopReason = 'end_turn'
  // 记录哪些 index 已初始化（防止 content_block_start 的 text 重复）
  const seenIndexes = new Set<number>()

  try {
    for await (const part of stream as any) {
      switch (part.type) {
        case 'message_start':
          // input usage 在这里（output_tokens 此时是 0）
          if (part.message?.usage) {
            inputTokens = part.message.usage.input_tokens ?? 0
            cacheRead = part.message.usage.cache_read_input_tokens ?? 0
          }
          break
        case 'content_block_start':
          // 强制清空：SDK 可能在 content_block_start.text 就发内容，然后 delta 又发
          if (part.content_block?.type === 'text') seenIndexes.add(part.index)
          break
        case 'content_block_delta':
          if (part.delta?.type === 'text_delta' && part.delta.text) {
            yield { type: 'text', textDelta: part.delta.text }
          }
          break
        case 'message_delta':
          // output 累计值；input 类不取（可能发 0 覆盖）
          if (part.usage) outputTokens = part.usage.output_tokens ?? outputTokens
          if (part.delta?.stop_reason) stopReason = part.delta.stop_reason
          break
        case 'message_stop':
          break
      }
    }
  } catch (e) {
    if (opts.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    yield { type: 'error', error: e as Error }
    return
  }

  yield { type: 'usage', input: inputTokens, output: outputTokens, cacheRead }
  yield { type: 'done', stopReason }
}
```

- [ ] **Step 4: 写实现 src/llm/anthropic.ts**

- [ ] **Step 5: 跑测试确认通过**（绿）

Run: `bun test tests/llm/anthropic.test.ts`
Expected: 3 tests PASS

- [ ] **Step 6: typecheck**

Run: `bun run typecheck`
Expected: 0 错误

- [ ] **Step 7: Commit**

```bash
git add src/llm/ tests/llm/
git commit -m "feat(llm): Anthropic 流式 async generator

- streamAnthropic() 用 messages.create({stream:true})，照搬 Claude Code 模式
- 自己累积 block，不用 MessageStream helper
- content_block_start 清空防重复；input/output token 分别取自 start/delta
- abort 转成 AbortError；支持 _clientOverride 用于测试 mock
- 3 tests PASS（文本流式 / 不重复 / abort）"
```

---

## Task 2: src/agent/types.ts + src/agent/queryLoop.ts（主循环无工具版 + 测试）

### Step 1: 写 src/agent/types.ts

```typescript
// src/agent/types.ts
// queryLoop 的事件契约。TUI 层（Repl）for await 消费这些事件做渲染。
export type QueryEvent =
  | { type: 'text_delta'; text: string }                    // 模型流式文本片段
  | { type: 'turn_end'; stopReason: string }                // 一轮结束
  | { type: 'usage'; input: number; output: number; cacheRead: number }
  | { type: 'aborted' }                                      // 被用户中断
  | { type: 'error'; error: Error; recoverable: boolean }
  | { type: 'done' }                                         // 整个 queryLoop 结束
```

- [ ] **Step 1: 写 src/agent/types.ts**

### Step 2: 写测试 tests/agent/queryLoop.test.ts

mock streamAnthropic，验证 queryLoop 正确转发事件 + 管理历史。

```typescript
// tests/agent/queryLoop.test.ts
import { test, expect, mock } from 'bun:test'

// mock llm 层
const mockStream = mock<(opts: object) => AsyncGenerator<object>>()
const { queryLoop } = await import('@/agent/queryLoop.js')

// 构造假 streamAnthropic 返回的事件序列
async function* fakeLlmEvents(events: object[]): AsyncGenerator<object> {
  for (const e of events) yield e
}

test('单轮对话：转发 text_delta + usage + done', async () => {
  mockStream.mockImplementation(() =>
    fakeLlmEvents([
      { type: 'text', textDelta: '你好' },
      { type: 'text', textDelta: '！' },
      { type: 'usage', input: 10, output: 5, cacheRead: 0 },
      { type: 'done', stopReason: 'end_turn' },
    ]) as any,
  )

  const out: object[] = []
  for await (const e of queryLoop({
    history: [{ role: 'user', content: 'hi' }],
    model: 'm',
    system: 's',
    signal: new AbortController().signal,
    _llmOverride: mockStream as any,
  })) {
    out.push(e)
  }

  // 应有：2 个 text_delta + 1 usage + 1 turn_end + 1 done（无工具所以一轮就 done）
  expect(out.filter((e: any) => e.type === 'text_delta').length).toBe(2)
  expect(out.find((e: any) => e.type === 'turn_end')).toBeDefined()
  expect(out.find((e: any) => e.type === 'done')).toBeDefined()
})

test('stop_reason 非 end_turn（如 max_tokens）也正常结束', async () => {
  mockStream.mockImplementation(() =>
    fakeLlmEvents([
      { type: 'text', textDelta: '截断' },
      { type: 'usage', input: 5, output: 100, cacheRead: 0 },
      { type: 'done', stopReason: 'max_tokens' },
    ]) as any,
  )
  const out: object[] = []
  for await (const e of queryLoop({
    history: [{ role: 'user', content: 'x' }],
    model: 'm',
    system: 's',
    signal: new AbortController().signal,
    _llmOverride: mockStream as any,
  })) {
    out.push(e)
  }
  const turnEnd = out.find((e: any) => e.type === 'turn_end') as any
  expect(turnEnd.stopReason).toBe('max_tokens')
})

test('abort 时 yield aborted + done', async () => {
  const ac = new AbortController()
  mockStream.mockImplementation(() => {
    throw new DOMException('Aborted', 'AbortError')
  })
  ac.abort()
  const out: object[] = []
  for await (const e of queryLoop({
    history: [{ role: 'user', content: 'x' }],
    model: 'm',
    system: 's',
    signal: ac.signal,
    _llmOverride: mockStream as any,
  })) {
    out.push(e)
  }
  expect(out.find((e: any) => e.type === 'aborted')).toBeDefined()
  expect(out.find((e: any) => e.type === 'done')).toBeDefined()
})
```

- [ ] **Step 2: 写测试 tests/agent/queryLoop.test.ts**

- [ ] **Step 3: 跑测试确认失败**

Run: `bun test tests/agent/queryLoop.test.ts`
Expected: FAIL — `Cannot find module '@/agent/queryLoop.js'`

### Step 4: 写实现 src/agent/queryLoop.ts

```typescript
// src/agent/queryLoop.ts
// 主循环 async generator（M2 无工具版）。
// 每次调用：把 userInput 加进 history，调 LLM，流式 yield 事件。
// M3 加工具后会扩展成 while 循环（有 tool_use 就继续），M2 是单轮。
import type { ChatMessage } from '@/llm/types.js'
import type { QueryEvent } from '@/agent/types.js'
import { streamAnthropic } from '@/llm/anthropic.js'

export interface QueryLoopOpts {
  history: ChatMessage[]                    // 已有对话历史（不含本次 user 输入）
  userInput: string                         // 本次用户输入
  model: string
  system: string
  maxTokens?: number
  signal: AbortSignal
  apiKey?: string
  // 测试用：注入 mock streamAnthropic
  _llmOverride?: (opts: object) => AsyncGenerator<object>
}

export async function* queryLoop(opts: QueryLoopOpts): AsyncGenerator<QueryEvent> {
  // 把 user 输入加进历史
  const messages: ChatMessage[] = [...opts.history, { role: 'user' as const, content: opts.userInput }]

  const streamFn = opts._llmOverride ?? (streamAnthropic as (o: object) => AsyncGenerator<object>)

  let assistantText = ''
  try {
    for await (const event of streamFn({
      model: opts.model,
      system: opts.system,
      messages,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
      apiKey: opts.apiKey,
    })) {
      const e = event as { type: string; textDelta?: string; input?: number; output?: number; cacheRead?: number; stopReason?: string }
      switch (e.type) {
        case 'text':
          if (e.textDelta) {
            assistantText += e.textDelta
            yield { type: 'text_delta', text: e.textDelta }
          }
          break
        case 'usage':
          yield { type: 'usage', input: e.input ?? 0, output: e.output ?? 0, cacheRead: e.cacheRead ?? 0 }
          break
        case 'done':
          yield { type: 'turn_end', stopReason: e.stopReason ?? 'end_turn' }
          break
        case 'error':
          yield { type: 'error', error: new Error('LLM error'), recoverable: true }
          break
      }
    }
  } catch (e) {
    if (opts.signal.aborted) {
      yield { type: 'aborted' }
      yield { type: 'done' }
      return
    }
    yield { type: 'error', error: e as Error, recoverable: false }
    yield { type: 'done' }
    return
  }

  yield { type: 'done' }
}

// 导出本轮累积的 assistant 文本，供调用方存入历史（Repl 用）
export function collectAssistantText(): string {
  return '' // 占位；实际在 queryLoop 内部累积，通过闭包返回
}
```

注：M2 单轮，history 管理在 Repl 层做（queryLoop 每次接收完整 history）。`collectAssistantText` 是占位，实际 assistant 文本由 Repl 在消费 text_delta 时累积。

- [ ] **Step 4: 写实现 src/agent/queryLoop.ts**

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/agent/queryLoop.test.ts`
Expected: 3 tests PASS

- [ ] **Step 6: typecheck + 全测试**

Run: `bun run typecheck && bun test`
Expected: 0 错误 + 全部 PASS（M1 16 + M2 6 = 22）

- [ ] **Step 7: Commit**

```bash
git add src/agent/ tests/agent/
git commit -m "feat(agent): queryLoop 主循环（M2 无工具版）

- queryLoop() async generator：接收 history + userInput，单轮调用 LLM
- 转发 text_delta / usage / turn_end / aborted / error / done 事件
- abort 时优雅 yield aborted + done
- 支持 _llmOverride 用于测试 mock"
```

---

## Task 3: src/agent/systemPrompt.ts（中文 system prompt）

```typescript
// src/agent/systemPrompt.ts
// M2 基础版中文 system prompt。M6 会加分段缓存。
export function buildSystemPrompt(): string {
  return `你叫 fuckcode，是一个运行在终端的 AI 编码助手。你会通过工具读取文件、修改代码、运行命令来帮助用户完成开发任务。

# 核心原则
- 用中文回复（除非用户用英文提问或代码相关内容）
- 回答简洁直接，不要啰嗦的免责声明
- 涉及代码时给出具体可执行的方案

# 当前环境
- 工作目录：${process.cwd()}
- 操作系统：${process.platform}
- 运行时：Bun ${Bun.version}

# 当前阶段
M2：仅支持纯文本对话，工具系统将在后续版本接入。`
}
```

- [ ] **Step 1: 写 src/agent/systemPrompt.ts**

- [ ] **Step 2: 验证 typecheck**

Run: `bun run typecheck`
Expected: 0 错误

- [ ] **Step 3: Commit**

```bash
git add src/agent/systemPrompt.ts
git commit -m "feat(agent): 中文 system prompt（M2 基础版）"
```

---

## Task 4: 改造 src/repl/Repl.tsx（接入 queryLoop + 流式渲染）

这是 M2 的集成点。把 M1 的"回显"改成真正调 queryLoop。

### 关键改动：
1. 维护 `history: ChatMessage[]` 状态（多轮上下文）
2. onSubmit 不再回显，而是启动 queryLoop
3. 用 AbortController 支持 Ctrl+C 中断
4. 流式累积 assistant 文本到 history

- [ ] **Step 1: 改造 Repl.tsx**

读当前 `/Users/shun/Desktop/fuck-code/src/repl/Repl.tsx`，把 onSubmit 和相关逻辑改成：

```tsx
// src/repl/Repl.tsx（改造后关键部分）
import React, { useState, useRef } from 'react'
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
  const chatHistoryRef = useRef<ChatMessage[]>([])   // 真实对话历史（给 LLM）
  const abortRef = useRef<AbortController | null>(null)
  const configRef = useRef<{ model: string; apiKey?: string; maxTokens: number } | null>(null)

  // 启动时读一次 config
  if (!configRef.current) {
    getConfig().then((c) => {
      configRef.current = { model: c.value.model, apiKey: c.value.apiKey, maxTokens: c.value.maxTokens }
    }).catch(() => {
      configRef.current = { model: 'claude-sonnet-4-5-20250929', maxTokens: 8192 }
    })
  }

  async function runQuery(text: string) {
    const config = configRef.current ?? { model: 'claude-sonnet-4-5-20250929', maxTokens: 8192 }
    const ac = new AbortController()
    abortRef.current = ac
    setRunning(true)

    // 新增一条空 assistant 消息，边收边填
    let assistantText = ''
    setHistory((h) => [...h, { role: 'user', text }, { role: 'assistant', text: '' }])

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
            // 存入真实历史
            chatHistoryRef.current = [...chatHistoryRef.current, { role: 'user', content: text }, { role: 'assistant', content: assistantText }]
            break
          case 'aborted':
            if (assistantText) {
              chatHistoryRef.current = [...chatHistoryRef.current, { role: 'user', content: text }, { role: 'assistant', content: assistantText + ' [已中断]' }]
            }
            break
          case 'done':
            break
          case 'error':
            setHistory((h) => {
              const copy = [...h]
              copy[copy.length - 1] = { role: 'assistant', text: `❌ 错误: ${event.error.message}` }
              return copy
            })
            break
        }
      }
    } catch (e) {
      setHistory((h) => {
        const copy = [...h]
        copy[copy.length - 1] = { role: 'assistant', text: `❌ 启动失败: ${String(e)}` }
        return copy
      })
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  useInput((inputChar, key) => {
    // Ctrl+C / Ctrl+D
    if (key.ctrl && (inputChar === 'c' || inputChar === 'd')) {
      if (running && abortRef.current) {
        abortRef.current.abort()  // 中断当前轮次，不退出
        return
      }
      exit()
      return
    }
    // 回车
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
    if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1))
      return
    }
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
            {m.role === 'user' ? '你' : 'fuckcode'}: {m.text}{m.role === 'assistant' && m.text === '' && running ? '▋' : ''}
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
```

- [ ] **Step 2: 更新 Repl 测试（tests/repl/Repl.test.tsx）**

旧测试检查"回显 M1 骨架模式"，现在改成检查"渲染欢迎语 + 输入框"（不测 LLM 调用，那个需要真实 API key，留给手动 E2E）。

```typescript
// tests/repl/Repl.test.tsx（更新）
import { test, expect } from 'bun:test'
import React from 'react'
import { render } from 'ink'
import { Repl } from '@/repl/Repl.js'

// 注意：Repl 现在会调用 getConfig()（异步），测试时用 mock 或忽略。
// M2 的 Repl 测试只验证静态渲染（欢迎框 + 输入框），不验证 queryLoop。

// 复用 M1 的 mock stdin/stdout 方案（见 tests/repl/Repl.test.tsx 现有实现）
// 保留原有的两个测试（渲染欢迎语 / 快捷键提示），它们应该仍然通过
// 因为欢迎框结构没变。

test('Repl 渲染欢迎语和输入框', () => {
  // ... 复用 M1 已有的 mock 实现
})

test('Repl 显示快捷键提示', () => {
  // ...
})
```

⚠️ 实现时：检查 M1 已有的 tests/repl/Repl.test.tsx 是否需要调整。如果欢迎框结构没变，测试应该仍 PASS。如果 getConfig() 的异步调用导致渲染问题，可能需要在测试里 mock runtime。

- [ ] **Step 3: 跑测试 + typecheck**

Run: `bun test && bun run typecheck`
Expected: 全部 PASS + 0 错误

- [ ] **Step 4: Commit**

```bash
git add src/repl/Repl.tsx tests/repl/Repl.test.tsx
git commit -m "feat(repl): 接入 queryLoop + 流式渲染

- 维护 chatHistoryRef 多轮上下文
- onSubmit 调 queryLoop，text_delta 实时累积渲染
- Ctrl+C 在运行时中断当前轮次（不退出），空闲时退出
- /clear 清空上下文
- 光标 ▋ 在生成时移到消息尾部"
```

---

## Task 5: 端到端验证（需真实 API key）

- [ ] **Step 1: 检查 ANTHROPIC_API_KEY**

Run: `echo $ANTHROPIC_API_KEY | head -c 10`
Expected: 输出 key 前缀（如 `sk-ant-api`）。若空，提示用户设置。

- [ ] **Step 2: 真实 E2E（手动，需 TTY）**

在真实终端运行：
```bash
bun run dev
```
测试场景：
1. 输入"你好"回车 → 流式显示中文回复
2. 输入"刚才我说了什么？"→ 验证多轮上下文（应记得"你好"）
3. 输入长问题，生成中按 Ctrl+C → 验证中断 + 部分文本保留
4. 输入 /clear → 验证上下文清空
5. 输入 /exit → 退出

- [ ] **Step 3: 记录验证结果**

向 controller 报告 E2E 验证是否通过。如无 API key，说明 M2 代码逻辑已通过单元测试（mock），E2E 待有 key 时验证。

- [ ] **Step 4: 更新 README（M2 状态）**

把 README 路线图里 M2 的状态从 ⬜ 改成 ✅，更新"当前状态"描述。

- [ ] **Step 5: M2 自检 + Commit**

```bash
# M2 自检
bun test && bun run typecheck
git add README.md
git commit -m "docs: README 更新 M2 完成"
```

---

## 自审清单（执行前运行）

- [ ] **spec 覆盖**：M2 范围（Anthropic 流式 + queryLoop 无工具 + 流式渲染 + abort）全部有 Task
- [ ] **无占位符**
- [ ] **类型一致**：LlmEvent / QueryEvent / ChatMessage 各 Task 间名称一致
- [ ] **依赖顺序**：Task 1 (llm) → Task 2 (queryLoop 依赖 llm) → Task 3 (systemPrompt) → Task 4 (Repl 依赖前三个)
- [ ] **测试覆盖**：llm 3 + queryLoop 3 = 6 新测试，加 M1 的 16 = 22 总测试

## 执行注意事项

1. **mock SDK**：anthropic.test.ts 用 `_clientOverride` 注入假 client，避免真实网络调用。生产代码不传这个参数。
2. **abort 语义**：Ctrl+C 在 running 时中断（不退出），空闲时退出——这是用户体验关键。
3. **不要提前实现 M3**：工具系统、StreamingToolExecutor 都是 M3，M2 严格只做纯文本对话。
4. **content_block_start 清空陷阱**：SDK 会重复发 text，必须在 anthropic.ts 里只认 content_block_delta 的 text。
