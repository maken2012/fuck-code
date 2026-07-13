// tests/instruction/customCommands.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadCustomCommands, renderTemplate } from '@/instruction/customCommands.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-cmd-test-' + process.pid)
const dotFuckcode = resolve(tmpDir, '.fuckcode', 'commands')

beforeEach(async () => {
  await mkdir(dotFuckcode, { recursive: true })
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

test('空命令目录返回空数组', async () => {
  const rmdir = resolve(tmpDir, '.fuckcode', 'commands-empty')
  expect(await loadCustomCommands(resolve(rmdir, '..'))).toEqual([])
})

test('读取 .md 命令文件', async () => {
  await writeFile(resolve(dotFuckcode, 'commit.md'), '帮我写 commit message。git diff：\n```\n!git diff\n```')
  const cmds = await loadCustomCommands(tmpDir)
  expect(cmds.length).toBe(1)
  expect(cmds[0]?.name).toBe('commit')
  expect(cmds[0]?.template).toContain('commit message')
})

test('解析 frontmatter', async () => {
  await writeFile(
    resolve(dotFuckcode, 'review.md'),
    `---\ndescription: 代码审查\nmodel: claude-opus-4-1-20250805\n---\n审查以下改动的代码质量：\n$ARGUMENTS`,
  )
  const cmds = await loadCustomCommands(tmpDir)
  expect(cmds[0]?.description).toBe('代码审查')
  expect(cmds[0]?.model).toBe('claude-opus-4-1-20250805')
})

test('renderTemplate 替换 $ARGUMENTS', () => {
  expect(renderTemplate('说：$ARGUMENTS', '你好世界')).toBe('说：你好世界')
})

test('renderTemplate 替换位置参数 $1 $2', () => {
  expect(renderTemplate('从 $1 到 $2', '起点 终点')).toBe('从 起点 到 终点')
})

test('renderTemplate 未提供的 $N 替换为空', () => {
  expect(renderTemplate('$1 $2 $3', '只有1')).toBe('只有1  ')
})
