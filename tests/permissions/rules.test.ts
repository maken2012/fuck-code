// tests/permissions/rules.test.ts
// 规则解析 + 匹配测试：parseRule / matchesRule（含通配符）。表驱动。
import { test, expect } from 'bun:test'
import { parseRule, matchesRule, type PermissionRule } from '@/permissions/rules.js'

// === parseRule ===
test('parseRule: 纯工具名 "Read" → { tool: "Read" }（无 contentPattern）', () => {
  expect(parseRule('Read')).toEqual({ tool: 'Read' })
})

test('parseRule: "Bash(git *)" → { tool: "Bash", contentPattern: "git *" }', () => {
  expect(parseRule('Bash(git *)')).toEqual({ tool: 'Bash', contentPattern: 'git *' })
})

test('parseRule: "Edit(src/**)" → { tool: "Edit", contentPattern: "src/**" }', () => {
  expect(parseRule('Edit(src/**)')).toEqual({ tool: 'Edit', contentPattern: 'src/**' })
})

test('parseRule: 空括号 "Bash()" 当作无 contentPattern', () => {
  expect(parseRule('Bash()')).toEqual({ tool: 'Bash' })
})

test('parseRule: 含特殊字符的 content "Bash(echo $HOME)"', () => {
  expect(parseRule('Bash(echo $HOME)')).toEqual({
    tool: 'Bash',
    contentPattern: 'echo $HOME',
  })
})

// === matchesRule：工具名匹配 ===
test('matchesRule: 工具名全等匹配（无 contentPattern 时只看 tool 名）', () => {
  const rule: PermissionRule = { tool: 'Read' }
  expect(matchesRule(rule, 'Read', { file_path: '/a' })).toBe(true)
  expect(matchesRule(rule, 'Write', { file_path: '/a' })).toBe(false)
})

// === matchesRule：Bash 通配符（command 字段） ===
test('matchesRule: Bash(git diff*) 匹配 "git diff --stat"', () => {
  const rule = parseRule('Bash(git diff*)')
  expect(matchesRule(rule, 'Bash', { command: 'git diff --stat' })).toBe(true)
  expect(matchesRule(rule, 'Bash', { command: 'git diff' })).toBe(true)
})

test('matchesRule: Bash(git diff*) 不匹配 "git push"', () => {
  const rule = parseRule('Bash(git diff*)')
  expect(matchesRule(rule, 'Bash', { command: 'git push' })).toBe(false)
})

test('matchesRule: Bash(git *) 匹配所有 git 子命令', () => {
  const rule = parseRule('Bash(git *)')
  expect(matchesRule(rule, 'Bash', { command: 'git status' })).toBe(true)
  expect(matchesRule(rule, 'Bash', { command: 'git commit -m fix' })).toBe(true)
  expect(matchesRule(rule, 'Bash', { command: 'npm install' })).toBe(false)
})

test('matchesRule: Bash 无通配符的精确匹配 "Bash(ls)"', () => {
  const rule = parseRule('Bash(ls)')
  expect(matchesRule(rule, 'Bash', { command: 'ls' })).toBe(true)
  expect(matchesRule(rule, 'Bash', { command: 'ls -la' })).toBe(false) // 精确
})

test('matchesRule: 工具名不匹配时返回 false（即使 content 匹配）', () => {
  const rule = parseRule('Bash(git *)')
  expect(matchesRule(rule, 'Edit', { command: 'git status' })).toBe(false)
})

// === matchesRule：Edit/Write 通配符（file_path 字段） ===
test('matchesRule: Edit(src/**) 匹配 src 下文件', () => {
  const rule = parseRule('Edit(src/**)')
  expect(matchesRule(rule, 'Edit', { file_path: 'src/foo.ts' })).toBe(true)
  expect(matchesRule(rule, 'Edit', { file_path: 'src/sub/bar.ts' })).toBe(true)
  expect(matchesRule(rule, 'Edit', { file_path: 'tests/baz.ts' })).toBe(false)
})

test('matchesRule: Write(README.md) 精确匹配文件名', () => {
  const rule = parseRule('Write(README.md)')
  expect(matchesRule(rule, 'Write', { file_path: 'README.md' })).toBe(true)
  expect(matchesRule(rule, 'Write', { file_path: 'src/README.md' })).toBe(false)
})

// === 边界情况 ===
test('matchesRule: input 无对应字段时，有 contentPattern 则视为不匹配', () => {
  const rule = parseRule('Bash(git *)')
  // input 缺 command 字段
  expect(matchesRule(rule, 'Bash', {})).toBe(false)
})

test('matchesRule: input 非 object（如裸字符串）不崩溃，返回 false', () => {
  const rule = parseRule('Bash(git *)')
  expect(matchesRule(rule, 'Bash', 'git status')).toBe(false)
})
