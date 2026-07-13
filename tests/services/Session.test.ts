// tests/services/Session.test.ts
// JSONL 会话持久化测试。用临时 HOME 隔离文件系统副作用（与 Config.test 同模式）。
//
// 覆盖：
// 1. createSession 创建 jsonl 文件 + 索引
// 2. appendMessages 追加、loadMessages 读回
// 3. 多次 append 后 load 返回全部
// 4. writeCompactBoundary 后 load 只返回 boundary（含）之后
// 5. listSessions 返回索引
// 6. 不存在的 session load 返回空
// 7. 空 jsonl load 返回空
// 8. sessions.json 不存在时 listSessions 返回空
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ChatMessage } from '@/llm/types.js'
import {
  createSession,
  appendMessages,
  loadMessages,
  listSessions,
  writeCompactBoundary,
} from '@/services/Session.js'
import { projectSessionDir } from '@/services/Paths.js'

// 临时 HOME，避免污染真实 ~/.fuckcode
const tmpHome = resolve(process.env.TMPDIR || '/tmp', 'fc-sess-test-home-' + process.pid)
const originalHome = process.env.HOME
const cwd = '/tmp/fc-sess-test-project' // 虚拟 cwd（hash 隔离）

beforeEach(async () => {
  await mkdir(resolve(tmpHome, '.fuckcode'), { recursive: true })
  process.env.HOME = tmpHome
})
afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true })
  process.env.HOME = originalHome
})

test('createSession 创建 jsonl 文件并写入 sessions.json 索引', async () => {
  const id = await createSession(cwd)
  expect(typeof id).toBe('string')
  expect(id.length).toBeGreaterThan(0)

  // jsonl 文件应存在（空）
  const jsonlPath = resolve(projectSessionDir(cwd), `${id}.jsonl`)
  await expect(stat(jsonlPath)).resolves.toBeDefined()

  // sessions.json 索引应含该 session
  const sessions = await listSessions(cwd)
  expect(sessions).toHaveLength(1)
  expect(sessions[0]!.id).toBe(id)
  expect(sessions[0]!.messageCount).toBe(0)
  expect(sessions[0]!.title).toBeDefined()
  expect(sessions[0]!.createdAt).toBeGreaterThan(0)
})

test('appendMessages 追加、loadMessages 读回', async () => {
  const id = await createSession(cwd)
  const msgs: ChatMessage[] = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: 'hi' },
  ]
  await appendMessages(id, cwd, msgs)

  const loaded = await loadMessages(id, cwd)
  expect(loaded).toHaveLength(2)
  expect(loaded[0]).toEqual({ role: 'user', content: '你好' })
  expect(loaded[1]).toEqual({ role: 'assistant', content: 'hi' })

  // 索引 messageCount 更新
  const sessions = await listSessions(cwd)
  expect(sessions[0]!.messageCount).toBe(2)
})

test('多次 append 后 load 返回全部', async () => {
  const id = await createSession(cwd)
  await appendMessages(id, cwd, [{ role: 'user', content: 'a' }])
  await appendMessages(id, cwd, [{ role: 'assistant', content: 'b' }])
  await appendMessages(id, cwd, [{ role: 'user', content: 'c' }])

  const loaded = await loadMessages(id, cwd)
  expect(loaded).toHaveLength(3)
  expect((loaded[0] as { content: string }).content).toBe('a')
  expect((loaded[2] as { content: string }).content).toBe('c')

  // 索引 messageCount 累加
  const sessions = await listSessions(cwd)
  expect(sessions[0]!.messageCount).toBe(3)
})

test('writeCompactBoundary 后 loadMessages 只返回 boundary（含）之后', async () => {
  const id = await createSession(cwd)
  await appendMessages(id, cwd, [
    { role: 'user', content: '旧1' },
    { role: 'assistant', content: '旧2' },
  ])
  await writeCompactBoundary(id, cwd, '这是摘要')
  await appendMessages(id, cwd, [
    { role: 'user', content: '新1' },
    { role: 'assistant', content: '新2' },
  ])

  const loaded = await loadMessages(id, cwd)
  // boundary + 新2条 = 3 条；旧2条被截断
  expect(loaded).toHaveLength(3)
  // 第一条是 compact boundary（含摘要）
  const boundary = loaded[0]!
  expect(boundary.role).toBe('user')
  // content 是结构化数组，text 含 <compact> 标签
  const blocks = boundary.content as Array<{ type: string; text: string }>
  expect(blocks[0]!.text).toContain('<compact>这是摘要</compact>')
  // 后两条是新消息
  expect((loaded[1] as { content: string }).content).toBe('新1')
  expect((loaded[2] as { content: string }).content).toBe('新2')
})

test('listSessions 返回索引（含多个会话）', async () => {
  const id1 = await createSession(cwd)
  const id2 = await createSession(cwd)
  await appendMessages(id1, cwd, [{ role: 'user', content: 'x' }])

  const sessions = await listSessions(cwd)
  expect(sessions).toHaveLength(2)
  const ids = sessions.map((s) => s.id).sort()
  expect(ids).toEqual([id1, id2].sort())
  // id1 加了消息
  const s1 = sessions.find((s) => s.id === id1)!
  expect(s1.messageCount).toBe(1)
})

test('不存在的 session load 返回空', async () => {
  const loaded = await loadMessages('nonexistent-id', cwd)
  expect(loaded).toEqual([])
})

test('空 jsonl load 返回空', async () => {
  const id = await createSession(cwd)
  // createSession 创建了空 jsonl，未追加任何消息
  const loaded = await loadMessages(id, cwd)
  expect(loaded).toEqual([])
})

test('sessions.json 不存在时 listSessions 返回空', async () => {
  // 未 createSession 的项目目录
  const sessions = await listSessions(cwd)
  expect(sessions).toEqual([])
})
