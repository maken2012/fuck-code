// tests/services/Paths.test.ts
import { test, expect } from 'bun:test'
import { fuckcodeDir, configPath, projectsDir, projectHash } from '@/services/Paths.js'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

test('fuckcodeDir 返回 ~/.fuckcode', () => {
  expect(fuckcodeDir()).toBe(resolve(homedir(), '.fuckcode'))
})

test('configPath 返回 ~/.fuckcode/config.json', () => {
  expect(configPath()).toBe(resolve(homedir(), '.fuckcode', 'config.json'))
})

test('projectsDir 返回 ~/.fuckcode/projects', () => {
  expect(projectsDir()).toBe(resolve(homedir(), '.fuckcode', 'projects'))
})

test('projectHash 对相同路径稳定，对不同路径不同', () => {
  const a = projectHash('/Users/shun/projA')
  const b = projectHash('/Users/shun/projA')
  const c = projectHash('/Users/shun/projB')
  expect(a).toBe(b)
  expect(a).not.toBe(c)
  expect(a).toMatch(/^[a-f0-9]{12,}$/)  // hex hash
})
