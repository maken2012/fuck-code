// tests/instruction/agentsMd.test.ts
// AGENTS.md 指令文件加载测试。
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadInstructions, hasInstructions, generateTemplate } from '@/instruction/agentsMd.js'

const tmpRoot = resolve(process.env.TMPDIR || '/tmp', 'fc-instr-test-' + process.pid)
const tmpCwd = resolve(tmpRoot, 'project')

beforeEach(async () => {
  await mkdir(tmpCwd, { recursive: true })
})
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

test('无指令文件返回 null', async () => {
  expect(await loadInstructions(tmpCwd)).toBeNull()
  expect(await hasInstructions(tmpCwd)).toBe(false)
})

test('读取 cwd 下的 AGENTS.md', async () => {
  await writeFile(resolve(tmpCwd, 'AGENTS.md'), '# 指令\n用 bun test')
  const result = await loadInstructions(tmpCwd)
  expect(result).toContain('用 bun test')
  expect(result).toContain('项目指令')
  expect(await hasInstructions(tmpCwd)).toBe(true)
})

test('CLAUDE.md 也被识别', async () => {
  await writeFile(resolve(tmpCwd, 'CLAUDE.md'), '# Claude 指令\n风格 A')
  const result = await loadInstructions(tmpCwd)
  expect(result).toContain('风格 A')
})

test('向上查找父目录的 AGENTS.md', async () => {
  // 父目录有 AGENTS.md，子目录没有
  await mkdir(resolve(tmpCwd, 'sub'), { recursive: true })
  await writeFile(resolve(tmpRoot, 'AGENTS.md'), '# 全局指令\n根级约定')
  const result = await loadInstructions(resolve(tmpCwd, 'sub'))
  expect(result).toContain('根级约定')
})

test('多层级合并（祖先 + 当前）', async () => {
  await mkdir(resolve(tmpCwd, 'sub'), { recursive: true })
  await writeFile(resolve(tmpRoot, 'AGENTS.md'), '# 根\n根级')
  await writeFile(resolve(tmpCwd, 'sub', 'AGENTS.md'), '# 子\n子级')
  const result = await loadInstructions(resolve(tmpCwd, 'sub'))
  expect(result).toContain('根级')
  expect(result).toContain('子级')
})

test('generateTemplate 含项目名占位', () => {
  const tpl = generateTemplate(tmpCwd)
  expect(tpl).toContain('AGENTS.md')
  expect(tpl).toContain('项目概述')
  expect(tpl).toContain('常用命令')
})
