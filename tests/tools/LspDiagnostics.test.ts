// tests/tools/LspDiagnostics.test.ts
import { test, expect } from 'bun:test'
import { resolve } from 'node:path'
import { LspDiagnosticsTool } from '@/tools/LspDiagnostics.js'

const ctx = { cwd: '/tmp', abortSignal: new AbortController().signal, readFileState: new Map() }

test('元数据', () => {
  expect(LspDiagnosticsTool.name).toBe('LspDiagnostics')
  expect(LspDiagnosticsTool.isReadOnly?.()).toBe(true)
  expect(LspDiagnosticsTool.isConcurrencySafe?.()).toBe(true)
})

test('文件不存在返回错误', async () => {
  const r = await LspDiagnosticsTool.execute({ file_path: '/tmp/nonexistent-lsp-test.ts' }, ctx)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toMatch(/不存在|not exist/i)
})

test('非 TS/JS 文件拒绝', async () => {
  // 用一个真实存在的非 TS 文件（README.md 在项目根）
  const r = await LspDiagnosticsTool.execute({ file_path: resolve(process.cwd(), 'README.md') }, ctx)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toMatch(/仅支持|ts|js/i)
})

test('jsonSchema 必填 file_path', () => {
  const schema = LspDiagnosticsTool.jsonSchema as { required: string[] }
  expect(schema.required).toContain('file_path')
})

test('inputSchema 必填 file_path', () => {
  const bad = LspDiagnosticsTool.inputSchema.safeParse({})
  expect(bad.success).toBe(false)
})
