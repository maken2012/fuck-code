// tests/eval/recorder.test.ts
// 录制/回放测试：验证录制后能准确回放 LlmEvent 序列。
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import type { LlmEvent } from '@/llm/types.js'
import {
  createRecordingWrapper,
  createReplayOverride,
  loadRecording,
  resolveLlmOverride,
} from '@/eval/recorder.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', `fc-eval-rec-test-${process.pid}-${Date.now()}`)

beforeEach(async () => {
  await mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// 构造假 LLM stream
async function* fakeStream(events: LlmEvent[]): AsyncGenerator<LlmEvent> {
  for (const e of events) yield e
}

test('录制：tee 事件到文件', async () => {
  const recordPath = join(tmpDir, 'rec.jsonl')
  const events: LlmEvent[] = [
    { type: 'text', textDelta: '你好' },
    { type: 'text', textDelta: '世界' },
    { type: 'usage', input: 10, output: 5, cacheRead: 0 },
    { type: 'done', stopReason: 'end_turn' },
  ]

  const wrapped = createRecordingWrapper(
    () => fakeStream(events),
    recordPath,
  )

  // 消费 wrapped stream
  const collected: LlmEvent[] = []
  for await (const e of wrapped({ model: 'test-model' })) {
    collected.push(e)
  }

  // 原始事件应该被透传
  expect(collected.length).toBe(4)
  expect(collected[0]).toEqual(events[0]!)

  // 录制文件应该有内容
  const content = await readFile(recordPath, 'utf8')
  const lines = content.trim().split('\n')
  expect(lines.length).toBe(1) // 一次调用一行

  const record = JSON.parse(lines[0]!)
  expect(record.callIndex).toBe(0)
  expect(record.modelHint).toBe('test-model')
  expect(record.events.length).toBe(4)
})

test('录制：多次调用记录多个 callIndex', async () => {
  const recordPath = join(tmpDir, 'multi.jsonl')
  let callCount = 0
  const realStream = (_opts: object): AsyncGenerator<LlmEvent> => {
    const idx = callCount++
    return fakeStream([
      { type: 'text', textDelta: `call-${idx}` },
      { type: 'done', stopReason: 'end_turn' },
    ])
  }

  const wrapped = createRecordingWrapper(realStream, recordPath)

  // 调 3 次
  for (let i = 0; i < 3; i++) {
    for await (const _e of wrapped({ model: 'm' })) {
      // 消费
    }
  }

  const recordings = await loadRecording(recordPath)
  expect(recordings.length).toBe(3)
  expect(recordings[0]!.callIndex).toBe(0)
  expect(recordings[1]!.callIndex).toBe(1)
  expect(recordings[2]!.callIndex).toBe(2)
})

test('回放：按 callIndex 顺序 yield 事件', async () => {
  const recordPath = join(tmpDir, 'replay.jsonl')

  // 先录制
  const events1: LlmEvent[] = [
    { type: 'text', textDelta: 'first' },
    { type: 'done', stopReason: 'end_turn' },
  ]
  const events2: LlmEvent[] = [
    { type: 'text', textDelta: 'second' },
    { type: 'done', stopReason: 'end_turn' },
  ]

  let callIdx = 0
  const realStream = (_opts: object): AsyncGenerator<LlmEvent> => {
    const events = callIdx++ === 0 ? events1 : events2
    return fakeStream(events)
  }
  const wrapped = createRecordingWrapper(realStream, recordPath)
  for await (const _ of wrapped({ model: 'm' })) {}
  for await (const _ of wrapped({ model: 'm' })) {}

  // 回放
  const override = await createReplayOverride(recordPath)
  const gen1 = override({})
  const gen2 = override({})

  const replay1: LlmEvent[] = []
  for await (const e of gen1) replay1.push(e)
  const replay2: LlmEvent[] = []
  for await (const e of gen2) replay2.push(e)

  expect(replay1[0]).toEqual({ type: 'text', textDelta: 'first' })
  expect(replay2[0]).toEqual({ type: 'text', textDelta: 'second' })
})

test('回放：录制用完后返回 done', async () => {
  const recordPath = join(tmpDir, 'exhaust.jsonl')
  const wrapped = createRecordingWrapper(
    () => fakeStream([{ type: 'done', stopReason: 'end_turn' }]),
    recordPath,
  )
  for await (const _ of wrapped({ model: 'm' })) {}

  const override = await createReplayOverride(recordPath)
  // 第一次回放：正常
  const gen1 = override({})
  const events1: LlmEvent[] = []
  for await (const e of gen1) events1.push(e)
  expect(events1.length).toBe(1)

  // 第二次回放：录制已用完，返回 done
  const gen2 = override({})
  const events2: LlmEvent[] = []
  for await (const e of gen2) events2.push(e)
  expect(events2.length).toBe(1)
  expect(events2[0]!.type).toBe('done')
})

test('resolveLlmOverride：live 模式返回 undefined', async () => {
  const result = await resolveLlmOverride('live', () => fakeStream([]), '/path')
  expect(result).toBeUndefined()
})

test('resolveLlmOverride：record 模式返回 wrapped 函数', async () => {
  const recordPath = join(tmpDir, 'resolve-rec.jsonl')
  const result = await resolveLlmOverride('record', () => fakeStream([]), recordPath)
  expect(result).toBeDefined()
  expect(typeof result).toBe('function')
})

test('resolveLlmOverride：replay 模式返回 override 函数', async () => {
  const recordPath = join(tmpDir, 'resolve-replay.jsonl')
  // 先建个空录制文件
  const { appendFile } = await import('node:fs/promises')
  await appendFile(recordPath, JSON.stringify({ callIndex: 0, modelHint: 'm', events: [{ type: 'done', stopReason: 'end_turn' }] }) + '\n')

  const result = await resolveLlmOverride('replay', () => fakeStream([]), recordPath)
  expect(result).toBeDefined()
  expect(typeof result).toBe('function')
})

test('loadRecording：空文件返回空数组', async () => {
  const { writeFile } = await import('node:fs/promises')
  const emptyPath = join(tmpDir, 'empty.jsonl')
  await writeFile(emptyPath, '')
  const recordings = await loadRecording(emptyPath)
  expect(recordings).toEqual([])
})

test('录制：包含 tool_use 事件正确保存', async () => {
  const recordPath = join(tmpDir, 'tooluse.jsonl')
  const events: LlmEvent[] = [
    { type: 'text', textDelta: '我来读文件' },
    { type: 'tool_use', toolName: 'Read', toolUseId: 't1', input: { file_path: '/x.ts' } },
    { type: 'usage', input: 100, output: 20, cacheRead: 0 },
    { type: 'done', stopReason: 'tool_use' },
  ]

  const wrapped = createRecordingWrapper(() => fakeStream(events), recordPath)
  for await (const _ of wrapped({ model: 'm' })) {}

  const recordings = await loadRecording(recordPath)
  expect(recordings[0]!.events.length).toBe(4)
  expect(recordings[0]!.events[1]!.type).toBe('tool_use')
})
