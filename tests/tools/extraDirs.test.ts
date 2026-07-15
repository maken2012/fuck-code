// tests/tools/extraDirs.test.ts
// 多目录工作区注册表测试
import { test, expect, beforeEach } from 'bun:test'
import { addExtraDir, getExtraDirs, getAllSearchDirs, clearExtraDirs } from '@/tools/extraDirs.js'
import { resolve } from 'node:path'

beforeEach(() => { clearExtraDirs() })

test('初始无额外目录', () => {
  clearExtraDirs()
  expect(getExtraDirs()).toEqual([])
})

test('addExtraDir 添加目录（相对路径解析为绝对）', () => {
  const abs = addExtraDir('../other', '/home/user/project')
  expect(abs).toBe(resolve('/home/user/project', '../other'))
  expect(getExtraDirs()).toContain(abs)
})

test('getAllSearchDirs 包含主 cwd + 额外目录', () => {
  addExtraDir('/tmp/extra1')
  addExtraDir('/tmp/extra2')
  const dirs = getAllSearchDirs('/main')
  expect(dirs[0]).toBe('/main')
  expect(dirs).toContain('/tmp/extra1')
  expect(dirs).toContain('/tmp/extra2')
  expect(dirs.length).toBe(3)
})

test('clearExtraDirs 清空', () => {
  addExtraDir('/tmp/x')
  clearExtraDirs()
  expect(getExtraDirs()).toEqual([])
  expect(getAllSearchDirs('/main')).toEqual(['/main'])
})
