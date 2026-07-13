// tests/tools/WebFetch.test.ts
import { test, expect } from 'bun:test'
import { WebFetchTool } from '@/tools/WebFetch.js'

const ctx = { cwd: '/tmp', abortSignal: new AbortController().signal, readFileState: new Map() }

test('SSRF 防护：拒绝 localhost', async () => {
  const r = await WebFetchTool.execute({ url: 'http://localhost:8080/secret' }, ctx)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toMatch(/内网|SSRF/i)
})

test('SSRF 防护：拒绝内网 IP', async () => {
  const r1 = await WebFetchTool.execute({ url: 'http://192.168.1.1' }, ctx)
  const r2 = await WebFetchTool.execute({ url: 'http://10.0.0.1' }, ctx)
  const r3 = await WebFetchTool.execute({ url: 'http://169.254.169.254' }, ctx)
  expect(r1.ok).toBe(false)
  expect(r2.ok).toBe(false)
  expect(r3.ok).toBe(false)
})

test('元数据：只读 + 并发安全', () => {
  expect(WebFetchTool.isReadOnly?.()).toBe(true)
  expect(WebFetchTool.isConcurrencySafe?.()).toBe(true)
})

test('inputSchema 必填 url', () => {
  const bad = WebFetchTool.inputSchema.safeParse({})
  expect(bad.success).toBe(false)
})
