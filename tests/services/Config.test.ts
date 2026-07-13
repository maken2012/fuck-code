// tests/services/Config.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadConfig } from '@/services/Config.js'

// 测试用临时目录覆盖 HOME，避免污染真实 ~/.fuckcode
// 注：Bun 的 homedir() 不读 process.env.HOME，但 Paths.ts 已改为优先读 HOME，
// 因此这里设置 process.env.HOME 即可隔离 user 级配置。
const tmpHome = resolve(process.env.TMPDIR || '/tmp', 'fc-test-home-' + process.pid)
const originalHome = process.env.HOME

beforeEach(async () => {
  await mkdir(resolve(tmpHome, '.fuckcode'), { recursive: true })
  process.env.HOME = tmpHome
})
afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true })
  process.env.HOME = originalHome
})

test('无配置文件时返回默认值', async () => {
  const cfg = await loadConfig()
  expect(cfg.model).toBe('claude-sonnet-4-5-20250929')
  expect(cfg.permissions.allow).toEqual([])
  expect(cfg.permissions.deny).toEqual([])
  expect(cfg.permissionMode).toBe('default')
  expect(cfg.contextWindow).toBe(200000)
})

test('读取用户级配置覆盖默认值', async () => {
  await writeFile(
    resolve(tmpHome, '.fuckcode', 'config.json'),
    JSON.stringify({ model: 'claude-opus-4-1', maxTokens: 4096 }),
  )
  const cfg = await loadConfig()
  expect(cfg.model).toBe('claude-opus-4-1')
  expect(cfg.maxTokens).toBe(4096)
  expect(cfg.permissionMode).toBe('default')  // 未设置的字段保留默认
})

test('配置 schema 拒绝非法 permissionMode', async () => {
  await writeFile(
    resolve(tmpHome, '.fuckcode', 'config.json'),
    JSON.stringify({ permissionMode: 'INVALID' }),
  )
  await expect(loadConfig()).rejects.toThrow()
})

test('project 级配置覆盖 user 级', async () => {
  await writeFile(
    resolve(tmpHome, '.fuckcode', 'config.json'),
    JSON.stringify({ model: 'user-level', maxTokens: 1000 }),
  )
  // 模拟项目级配置
  const projectConfigPath = resolve(process.cwd(), '.fuckcode', 'config.json')
  await mkdir(resolve(process.cwd(), '.fuckcode'), { recursive: true })
  await writeFile(projectConfigPath, JSON.stringify({ maxTokens: 9999 }))
  try {
    const cfg = await loadConfig({ cwd: process.cwd() })
    expect(cfg.model).toBe('user-level')        // 来自 user 级
    expect(cfg.maxTokens).toBe(9999)            // 来自 project 级（覆盖）
  } finally {
    await rm(resolve(process.cwd(), '.fuckcode'), { recursive: true, force: true })
  }
})
