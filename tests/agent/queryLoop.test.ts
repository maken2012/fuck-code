// tests/agent/queryLoop.test.ts
// mock streamAnthropic via _llmOverride，验证 queryLoop 的事件转发 / abort / 工具循环逻辑。
import { test, expect, mock, beforeEach } from 'bun:test'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { LlmEvent } from '@/llm/types.js'
import { ReadTool } from '@/tools/Read.js'

// 用动态 import 加载被测模块（顶层 await）
const { queryLoop } = await import('@/agent/queryLoop.js')

// _llmOverride 的签名：与 queryLoop 内 _llmOverride 一致（接收 opts: object，返回 LlmEvent 异步生成器）
// 用 object 是为了让 mock 不必精确刻画 LLM 子选项，且与生产 streamAnthropic 调用点兼容。
type LlmStreamFn = (opts: object) => AsyncGenerator<LlmEvent>

// mock 的 streamAnthropic —— 默认空生成器，每个 test 用 mockImplementation 覆盖
const mockStream = mock<LlmStreamFn>(async function* () {
  /* empty */
})

// 构造假 streamAnthropic 返回的事件序列
async function* fakeLlmEvents(events: LlmEvent[]): AsyncGenerator<LlmEvent> {
  for (const e of events) yield e
}

beforeEach(() => mockStream.mockClear())

test('单轮对话：转发 text_delta + usage + turn_end + done', async () => {
  mockStream.mockImplementation(() =>
    fakeLlmEvents([
      { type: 'text', textDelta: '你好' },
      { type: 'text', textDelta: '！' },
      { type: 'usage', input: 10, output: 5, cacheRead: 0 },
      { type: 'done', stopReason: 'end_turn' },
    ]),
  )

  const out = []
  for await (const e of queryLoop({
    history: [],
    userInput: 'hi',
    model: 'm',
    system: 's',
    cwd: '/tmp',
    signal: new AbortController().signal,
    _llmOverride: mockStream,
  })) {
    out.push(e)
  }

  // 应有：2 个 text_delta + 1 usage + 1 turn_end + 1 done（无工具所以一轮就 done）
  expect(out.filter((e) => e.type === 'text_delta').length).toBe(2)
  expect(out.find((e) => e.type === 'turn_end')).toBeDefined()
  expect(out.find((e) => e.type === 'usage')).toBeDefined()
  expect(out.find((e) => e.type === 'done')).toBeDefined()
})

test('stop_reason 非 end_turn（如 max_tokens）也正常结束', async () => {
  mockStream.mockImplementation(() =>
    fakeLlmEvents([
      { type: 'text', textDelta: '截断' },
      { type: 'usage', input: 5, output: 100, cacheRead: 0 },
      { type: 'done', stopReason: 'max_tokens' },
    ]),
  )
  const out = []
  for await (const e of queryLoop({
    history: [],
    userInput: 'x',
    model: 'm',
    system: 's',
    cwd: '/tmp',
    signal: new AbortController().signal,
    _llmOverride: mockStream,
  })) {
    out.push(e)
  }
  const turnEnd = out.find((e) => e.type === 'turn_end')
  if (turnEnd && turnEnd.type === 'turn_end') {
    expect(turnEnd.stopReason).toBe('max_tokens')
  } else {
    throw new Error('missing turn_end')
  }
})

test('abort 时 yield aborted + done', async () => {
  const ac = new AbortController()
  // mock 的 stream 直接抛 AbortError（模拟 streamAnthropic abort 行为）
  mockStream.mockImplementation(() => {
    throw new DOMException('Aborted', 'AbortError')
  })
  ac.abort()
  const out = []
  for await (const e of queryLoop({
    history: [],
    userInput: 'x',
    model: 'm',
    system: 's',
    cwd: '/tmp',
    signal: ac.signal,
    _llmOverride: mockStream,
  })) {
    out.push(e)
  }
  expect(out.find((e) => e.type === 'aborted')).toBeDefined()
  expect(out.find((e) => e.type === 'done')).toBeDefined()
})

// M3 工具循环测试：mock LLM 第一轮返回 tool_use(Read)，第二轮返回纯文本。
// 用真实 Read 工具 + 临时文件（不 mock 工具本身，只 mock LLM）。
test('工具调用循环：第一轮 tool_use → 执行 → 第二轮文本 → done', async () => {
  const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-qloop-test-' + process.pid)
  await mkdir(tmpDir, { recursive: true })
  const filePath = resolve(tmpDir, 'hello.ts')
  await writeFile(filePath, 'export const greeting = "hi"\n')

  try {
    // 第一次调用返回 tool_use；第二次返回纯文本
    let callCount = 0
    mockStream.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return fakeLlmEvents([
          { type: 'text', textDelta: '我来读一下文件' },
          {
            type: 'tool_use',
            toolName: 'Read',
            toolUseId: 'toolu_1',
            input: { file_path: filePath },
          },
          { type: 'usage', input: 20, output: 10, cacheRead: 0 },
          { type: 'done', stopReason: 'tool_use' },
        ])
      }
      return fakeLlmEvents([
        { type: 'text', textDelta: '文件内容是 hi' },
        { type: 'usage', input: 30, output: 5, cacheRead: 0 },
        { type: 'done', stopReason: 'end_turn' },
      ])
    })

    const out = []
    for await (const e of queryLoop({
      history: [],
      userInput: '读一下文件',
      model: 'm',
      system: 's',
      cwd: tmpDir,
      tools: [ReadTool],
      signal: new AbortController().signal,
      _llmOverride: mockStream,
    })) {
      out.push(e)
    }

    // 第一轮：tool_use_start
    const toolUseStart = out.find((e) => e.type === 'tool_use_start')
    if (toolUseStart && toolUseStart.type === 'tool_use_start') {
      expect(toolUseStart.tool).toBe('Read')
      expect(toolUseStart.input).toEqual({ file_path: filePath })
    } else {
      throw new Error('missing tool_use_start')
    }

    // tool_result：成功，内容含文件内容
    const toolResult = out.find((e) => e.type === 'tool_result')
    if (toolResult && toolResult.type === 'tool_result') {
      expect(toolResult.tool).toBe('Read')
      expect(toolResult.ok).toBe(true)
      expect(toolResult.content).toContain('greeting = "hi"')
    } else {
      throw new Error('missing tool_result')
    }

    // 第二轮：text_delta
    const textDeltas = out.filter((e) => e.type === 'text_delta')
    // 第一轮 1 段 + 第二轮 1 段
    expect(textDeltas.length).toBe(2)

    // 两个 turn_end（第一轮 tool_use，第二轮 end_turn）
    const turnEnds = out.filter((e) => e.type === 'turn_end')
    expect(turnEnds.length).toBe(2)

    // 最终 done
    expect(out.find((e) => e.type === 'done')).toBeDefined()
    // streamFn 应被调用 2 次
    expect(callCount).toBe(2)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

// 工具执行失败时把错误回灌给模型（不终止循环），第二轮模型应能正常回复
test('工具失败：tool_result ok=false 但循环继续', async () => {
  let callCount = 0
  mockStream.mockImplementation(() => {
    callCount++
    if (callCount === 1) {
      return fakeLlmEvents([
        {
          type: 'tool_use',
          toolName: 'Read',
          toolUseId: 'toolu_1',
          input: { file_path: '/definitely/not/exist.ts' },
        },
        { type: 'done', stopReason: 'tool_use' },
      ])
    }
    return fakeLlmEvents([
      { type: 'text', textDelta: '文件不存在' },
      { type: 'done', stopReason: 'end_turn' },
    ])
  })

  const out = []
  for await (const e of queryLoop({
    history: [],
    userInput: '读不存在的文件',
    model: 'm',
    system: 's',
    cwd: '/tmp',
    tools: [ReadTool],
    signal: new AbortController().signal,
    _llmOverride: mockStream,
  })) {
    out.push(e)
  }

  const toolResult = out.find((e) => e.type === 'tool_result')
  if (toolResult && toolResult.type === 'tool_result') {
    expect(toolResult.ok).toBe(false)
    expect(toolResult.content).toMatch(/不存在|ENOENT/i)
  } else {
    throw new Error('missing tool_result')
  }
  // 循环继续到第二轮
  expect(callCount).toBe(2)
  expect(out.find((e) => e.type === 'done')).toBeDefined()
})
