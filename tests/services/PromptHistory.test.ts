// tests/services/PromptHistory.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadPromptHistory, appendPromptHistory } from '@/services/PromptHistory.js'

const tmpHome = resolve(process.env.TMPDIR || '/tmp', 'fc-hist-test-' + process.pid)
const origHome = process.env.HOME

beforeEach(async () => {
  await mkdir(resolve(tmpHome, '.fuckcode'), { recursive: true })
  process.env.HOME = tmpHome
})
afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true })
  process.env.HOME = origHome
})

test('空历史返回空数组', async () => {
  expect(await loadPromptHistory('/tmp/test-project')).toEqual([])
})

test('追加后能加载', async () => {
  await appendPromptHistory('/tmp/proj-a', '你好')
  const hist = await loadPromptHistory('/tmp/proj-a')
  expect(hist).toContain('你好')
})

test('去重连续相同项', async () => {
  await appendPromptHistory('/tmp/proj-b', '同样的话')
  await appendPromptHistory('/tmp/proj-b', '同样的话') // 连续相同，不重复存
  const hist = await loadPromptHistory('/tmp/proj-b')
  const count = hist.filter((h) => h === '同样的话').length
  expect(count).toBe(1)
})

test('不同项目隔离', async () => {
  await appendPromptHistory('/tmp/proj-c', '项目C')
  await appendPromptHistory('/tmp/proj-d', '项目D')
  const histC = await loadPromptHistory('/tmp/proj-c')
  const histD = await loadPromptHistory('/tmp/proj-d')
  expect(histC).toContain('项目C')
  expect(histC).not.toContain('项目D')
  expect(histD).toContain('项目D')
})

test('最近在前', async () => {
  await appendPromptHistory('/tmp/proj-e', '第一条')
  await appendPromptHistory('/tmp/proj-e', '第二条')
  const hist = await loadPromptHistory('/tmp/proj-e')
  expect(hist[0]).toBe('第二条') // 最近在前
  expect(hist[1]).toBe('第一条')
})

test('空文本不追加', async () => {
  await appendPromptHistory('/tmp/proj-f', '   ')
  const hist = await loadPromptHistory('/tmp/proj-f')
  expect(hist).toEqual([])
})
