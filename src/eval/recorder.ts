// src/eval/recorder.ts
// LLM 响应录制/回放。零侵入：只通过 queryLoop 的 _llmOverride 钩子工作。
//
// 三种模式：
// - live：不干预，正常调真实 API
// - record：包一层，tee LlmEvent 序列到 JSONL 文件
// - replay：读 JSONL，按 queryLoop 调用顺序逐条 yield 录制的事件
//
// 录制格式（每行一个 JSON 对象）：
//   { "callIndex": 0, "modelHint": "claude-...", "events": [ {...}, {...} ] }
// callIndex 是 queryLoop 内部第几次调 LLM（从 0 开始）。replay 按这个顺序消费。
//
// 关键：queryLoop 每次调 streamFn() 算一次 callIndex。
// 录制时 wrapper 内部自增计数器；回放时 override 内部自增计数器。
import type { LlmEvent } from '@/llm/types.js'
import type { LlmMode } from '@/eval/types.js'
import { appendFile, readFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * 创建 LLM stream 函数包装器（录制模式）。
 * 包住真实的 stream 函数，每次调用时 tee 事件到 JSONL 文件。
 *
 * @param realStream 真实 stream 函数（如 LLMClient.stream 或 streamMessage）
 * @param recordPath 录制文件路径
 * @returns 包装后的 stream 函数，签名与原函数一致
 */
export function createRecordingWrapper<T extends object>(
  realStream: (opts: T) => AsyncGenerator<LlmEvent>,
  recordPath: string,
): (opts: T) => AsyncGenerator<LlmEvent> {
  let callIndex = 0

  return async function* (opts: T): AsyncGenerator<LlmEvent> {
    const currentIndex = callIndex++
    const events: LlmEvent[] = []
    // 记录调用摘要（不含完整 messages，太大了；只记 model）
    const modelHint = (opts as { model?: string }).model ?? 'unknown'

    // 确保 dir 存在
    await mkdir(dirname(recordPath), { recursive: true }).catch(() => {})

    for await (const event of realStream(opts)) {
      events.push(event)
      yield event
    }

    // stream 结束后，把这次调用的所有事件追加写入 JSONL
    const line = JSON.stringify({ callIndex: currentIndex, modelHint, events }) + '\n'
    await appendFile(recordPath, line, 'utf8').catch(() => {})
  }
}

/**
 * 创建回放 override 函数（replay 模式）。
 * 读录制文件，按 callIndex 顺序逐条 yield 录制的 LlmEvent。
 *
 * @param replayPath 录制文件路径
 * @returns _llmOverride 用的 stream 函数
 */
export async function createReplayOverride(
  replayPath: string,
): Promise<(opts: object) => AsyncGenerator<LlmEvent>> {
  const recordings = await loadRecording(replayPath)
  let callIndex = 0

  return async function* (_opts: object): AsyncGenerator<LlmEvent> {
    const record = recordings[callIndex++]
    if (!record) {
      // 录制用完了（queryLoop 调了更多次 LLM），返回 done 终止
      yield { type: 'done', stopReason: 'end_turn' }
      return
    }
    for (const event of record.events) {
      yield event
    }
  }
}

/** 录制记录类型 */
export interface RecordingEntry {
  callIndex: number
  modelHint: string
  events: LlmEvent[]
}

/** 加载录制文件，按 callIndex 排序 */
export async function loadRecording(path: string): Promise<RecordingEntry[]> {
  const content = await readFile(path, 'utf8')
  return content
    .trim()
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RecordingEntry)
    .sort((a, b) => a.callIndex - b.callIndex)
}

/**
 * 根据 llmMode 决定用哪种 stream 函数，返回 _llmOverride（或 undefined=不 override）。
 *
 * @param llmMode live=不干预 / record=录制 / replay=回放
 * @param realStream 真实 stream 函数
 * @param modeSpecificPath record 时=录制文件路径；replay 时=回放文件路径
 */
export async function resolveLlmOverride<T extends object>(
  llmMode: LlmMode,
  realStream: (opts: T) => AsyncGenerator<LlmEvent>,
  modeSpecificPath?: string,
): Promise<((opts: T) => AsyncGenerator<LlmEvent>) | undefined> {
  switch (llmMode) {
    case 'live':
      return undefined
    case 'record':
      if (!modeSpecificPath) return undefined
      return createRecordingWrapper(realStream, modeSpecificPath)
    case 'replay':
      if (!modeSpecificPath) return undefined
      // replay 返回的 override 签名是 (opts: object)，但 queryLoop 接受这个
      const override = await createReplayOverride(modeSpecificPath)
      return override as unknown as (opts: T) => AsyncGenerator<LlmEvent>
  }
}
