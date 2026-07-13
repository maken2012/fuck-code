// tests/hooks/HookManager.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadHooks, triggerHooks, matchesMatcher } from '@/hooks/HookManager.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-hook-test-' + process.pid)

beforeEach(async () => {
  await mkdir(resolve(tmpDir, '.fuckcode'), { recursive: true })
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

test('matchesMatcher：精确匹配', () => {
  expect(matchesMatcher('Edit', 'Edit')).toBe(true)
  expect(matchesMatcher('Edit', 'Read')).toBe(false)
})

test('matchesMatcher：| 分隔', () => {
  expect(matchesMatcher('Edit|Write', 'Edit')).toBe(true)
  expect(matchesMatcher('Edit|Write', 'Write')).toBe(true)
  expect(matchesMatcher('Edit|Write', 'Bash')).toBe(false)
})

test('matchesMatcher：* 通配符', () => {
  expect(matchesMatcher('*', '任何')).toBe(true)
  expect(matchesMatcher('Bash*', 'Bash')).toBe(true)
})

test('matchesMatcher：空 matcher 匹配所有', () => {
  expect(matchesMatcher('', '任何')).toBe(true)
})

test('loadHooks：无配置文件返回空', async () => {
  const hooks = await loadHooks(tmpDir)
  expect(hooks).toEqual({})
})

test('loadHooks：读取 hooks.json', async () => {
  await writeFile(
    resolve(tmpDir, '.fuckcode', 'hooks.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit', command: 'echo hi' }] } }),
  )
  const hooks = await loadHooks(tmpDir)
  expect(hooks.hooks?.PreToolUse?.length).toBe(1)
})

test('triggerHooks：执行命令返回 additionalContext', async () => {
  const hooks = { hooks: { UserPromptSubmit: [{ command: 'echo "额外上下文"' }] } }
  const result = await triggerHooks('UserPromptSubmit', { prompt: 'test' }, hooks, tmpDir)
  expect(result.additionalContext).toContain('额外上下文')
})

test('triggerHooks：PreToolUse 返回 JSON 决策', async () => {
  const hooks = {
    hooks: {
      PreToolUse: [{ matcher: 'Edit', command: 'echo \'{"permissionDecision":"deny"}\'' }],
    },
  }
  const result = await triggerHooks('PreToolUse', { tool: 'Edit', toolInput: {} }, hooks, tmpDir)
  expect(result.permissionDecision).toBe('deny')
})

test('triggerHooks：matcher 不匹配则跳过', async () => {
  const hooks = {
    hooks: {
      PreToolUse: [{ matcher: 'Edit', command: 'echo \'{"permissionDecision":"deny"}\'' }],
    },
  }
  const result = await triggerHooks('PreToolUse', { tool: 'Read', toolInput: {} }, hooks, tmpDir)
  expect(result.permissionDecision).toBeUndefined()
})

test('triggerHooks：hook 错误不阻塞', async () => {
  const hooks = { hooks: { UserPromptSubmit: [{ command: 'nonexistent-command-xyz' }] } }
  const result = await triggerHooks('UserPromptSubmit', { prompt: 'x' }, hooks, tmpDir)
  // 不抛错（错误被捕获）
  expect(result).toBeDefined()
})
