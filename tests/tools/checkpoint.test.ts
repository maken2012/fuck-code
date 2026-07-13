// tests/tools/checkpoint.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { checkpoint, listCheckpoints, restoreCheckpoint } from '@/tools/checkpoint.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-cp-test-' + process.pid)

beforeEach(async () => {
  await mkdir(tmpDir, { recursive: true })
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

test('checkpoint 备份存在的文件', async () => {
  const filePath = resolve(tmpDir, 'foo.txt')
  await writeFile(filePath, '原始内容')
  const cp = await checkpoint(tmpDir, filePath)
  expect(cp).not.toBeNull()
  expect(cp?.originalPath).toBe(filePath)
})

test('checkpoint 不存在的文件返回 null', async () => {
  const cp = await checkpoint(tmpDir, resolve(tmpDir, 'nope.txt'))
  expect(cp).toBeNull()
})

test('listCheckpoints 返回备份列表', async () => {
  const filePath = resolve(tmpDir, 'bar.txt')
  await writeFile(filePath, 'v1')
  await checkpoint(tmpDir, filePath)
  await writeFile(filePath, 'v2')
  await checkpoint(tmpDir, filePath)
  const list = await listCheckpoints(tmpDir, filePath)
  expect(list.length).toBe(2)
  // 最近的在前
  expect(list[0]?.timestamp).toBeGreaterThanOrEqual(list[1]?.timestamp ?? 0)
})

test('restoreCheckpoint 恢复文件内容', async () => {
  const filePath = resolve(tmpDir, 'restore.txt')
  await writeFile(filePath, '原版')
  const cp = await checkpoint(tmpDir, filePath)
  await writeFile(filePath, '改坏了')
  // 恢复
  const ok = await restoreCheckpoint(tmpDir, cp!.id)
  expect(ok).toBe(true)
  const content = await readFile(filePath, 'utf8')
  expect(content).toBe('原版')
})

test('restoreCheckpoint 无效 id 返回 false', async () => {
  const ok = await restoreCheckpoint(tmpDir, 'nonexistent-id')
  expect(ok).toBe(false)
})

test('listCheckpoints 无备份返回空', async () => {
  expect(await listCheckpoints(tmpDir)).toEqual([])
})
