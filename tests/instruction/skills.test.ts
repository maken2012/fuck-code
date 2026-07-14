// tests/instruction/skills.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadSkills, formatSkillsForPrompt, loadSkillContent } from '@/instruction/skills.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-skill-test-' + process.pid)

beforeEach(async () => {
  await mkdir(resolve(tmpDir, '.fuckcode', 'skills'), { recursive: true })
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

test('无 skill 目录返回空', async () => {
  expect(await loadSkills('/tmp/nonexistent-fc-skill-xyz')).toEqual([])
})

test('加载 skill（SKILL.md + frontmatter）', async () => {
  await mkdir(resolve(tmpDir, '.fuckcode', 'skills', 'vue-debug'), { recursive: true })
  await writeFile(
    resolve(tmpDir, '.fuckcode', 'skills', 'vue-debug', 'SKILL.md'),
    `---
name: vue-debug
description: Vue 组件调试技巧
effort: high
---

# Vue 调试
用 Vue DevTools 检查组件树...`,
  )
  const skills = await loadSkills(tmpDir)
  expect(skills.length).toBe(1)
  expect(skills[0]?.name).toBe('vue-debug')
  expect(skills[0]?.description).toBe('Vue 组件调试技巧')
  expect(skills[0]?.effort).toBe('high')
  expect(skills[0]?.content).toContain('Vue DevTools')
})

test('formatSkillsForPrompt 只含 name+description（不含正文）', () => {
  const formatted = formatSkillsForPrompt([
    { name: 'react-perf', description: 'React 性能优化', content: '详细内容很长'.repeat(100), dir: '/x' },
  ])
  expect(formatted).toContain('react-perf')
  expect(formatted).toContain('React 性能优化')
  expect(formatted).not.toContain('详细内容很长') // 正文不注入（用完整的重复串判断）
  expect(formatted).toContain('skill 工具加载')
})

test('formatSkillsForPrompt 空返回空字符串', () => {
  expect(formatSkillsForPrompt([])).toBe('')
})

test('loadSkillContent 加载完整正文', async () => {
  await mkdir(resolve(tmpDir, '.fuckcode', 'skills', 'ts-tips'), { recursive: true })
  await writeFile(
    resolve(tmpDir, '.fuckcode', 'skills', 'ts-tips', 'SKILL.md'),
    `---
name: ts-tips
description: TS 技巧
---

# TS 技巧正文
用 satisfies 操作符...`,
  )
  const content = await loadSkillContent(tmpDir, 'ts-tips')
  expect(content).toContain('satisfies')
  expect(content).not.toContain('---') // frontmatter 被去掉
})

test('loadSkillContent 不存在的 skill 返回 null', async () => {
  expect(await loadSkillContent(tmpDir, 'nonexistent')).toBeNull()
})

test('兼容 .claude/skills 目录', async () => {
  await mkdir(resolve(tmpDir, '.claude', 'skills', 'cc-skill'), { recursive: true })
  await writeFile(
    resolve(tmpDir, '.claude', 'skills', 'cc-skill', 'SKILL.md'),
    '---\nname: cc-skill\ndescription: CC 兼容\n---\n内容',
  )
  const skills = await loadSkills(tmpDir)
  expect(skills.some((s) => s.name === 'cc-skill')).toBe(true)
})
