// tests/permissions/decision.test.ts
// checkPermission 决策管线测试（表驱动）。
// 决策顺序：bypass → plan+非只读 → deny 规则 → allow 规则 → ask 规则 → 默认（只读 allow/写 ask）
import { test, expect } from 'bun:test'
import { checkPermission } from '@/permissions/decision.js'
import type { PermissionMode } from '@/permissions/modes.js'
import type { Tool } from '@/tools/Tool.js'
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'

// 测试用工具构造器：可控 isReadOnly
function makeTool(name: string, isReadOnly: boolean): Tool {
  return buildTool<unknown>({
    name,
    description: name,
    prompt: name,
    inputSchema: z.unknown(),
    isReadOnly: () => isReadOnly,
    async execute() {
      return { ok: true, data: '' }
    },
  })
}

const ReadTool = makeTool('Read', true)
const EditTool = makeTool('Edit', false)
const BashTool = makeTool('Bash', false)

const ctx = {
  cwd: '/tmp',
  abortSignal: new AbortController().signal,
  readFileState: new Map<string, { mtime: number; readAt: number }>(),
}

interface Case {
  name: string
  tool: Tool
  input: unknown
  mode: PermissionMode
  rules: { allow: string[]; ask: string[]; deny: string[] }
  expected: 'allow' | 'ask' | 'deny'
}

const cases: Case[] = [
  {
    name: 'bypassPermissions → 一律 allow（即使写）',
    tool: EditTool,
    input: { file_path: 'a' },
    mode: 'bypassPermissions',
    rules: { allow: [], ask: [], deny: [] },
    expected: 'allow',
  },
  {
    name: 'plan 模式 + 非只读（Edit）→ deny',
    tool: EditTool,
    input: { file_path: 'a' },
    mode: 'plan',
    rules: { allow: [], ask: [], deny: [] },
    expected: 'deny',
  },
  {
    name: 'plan 模式 + 只读（Read）→ allow（plan 只挡写）',
    tool: ReadTool,
    input: { file_path: 'a' },
    mode: 'plan',
    rules: { allow: [], ask: [], deny: [] },
    expected: 'allow',
  },
  {
    name: 'deny 规则匹配 → deny（优先级高于 allow/ask）',
    tool: BashTool,
    input: { command: 'rm -rf /' },
    mode: 'default',
    rules: { allow: ['Bash(*)'], ask: [], deny: ['Bash(rm *)'] },
    expected: 'deny',
  },
  {
    name: 'allow 规则匹配 → allow（写工具也放行）',
    tool: EditTool,
    input: { file_path: 'src/foo.ts' },
    mode: 'default',
    rules: { allow: ['Edit(src/**)'], ask: [], deny: [] },
    expected: 'allow',
  },
  {
    name: 'allow 规则不匹配（默认写 ask）→ ask',
    tool: EditTool,
    input: { file_path: 'docs/foo.md' },
    mode: 'default',
    rules: { allow: ['Edit(src/**)'], ask: [], deny: [] },
    expected: 'ask',
  },
  {
    name: 'ask 规则匹配 → ask',
    tool: BashTool,
    input: { command: 'npm install' },
    mode: 'default',
    rules: { allow: [], ask: ['Bash(npm *)'], deny: [] },
    expected: 'ask',
  },
  {
    name: '默认 + 只读工具 → allow',
    tool: ReadTool,
    input: { file_path: 'a' },
    mode: 'default',
    rules: { allow: [], ask: [], deny: [] },
    expected: 'allow',
  },
  {
    name: '默认 + 写工具（无任何规则）→ ask（fail-safe）',
    tool: BashTool,
    input: { command: 'echo hi' },
    mode: 'default',
    rules: { allow: [], ask: [], deny: [] },
    expected: 'ask',
  },
  {
    name: 'deny 优先于 ask（同时匹配 deny 和 ask）→ deny',
    tool: BashTool,
    input: { command: 'git push' },
    mode: 'default',
    rules: { allow: [], ask: ['Bash(git *)'], deny: ['Bash(git push)'] },
    expected: 'deny',
  },
  {
    name: 'deny 优先于 allow（同时匹配）→ deny',
    tool: EditTool,
    input: { file_path: 'secrets/key' },
    mode: 'default',
    rules: { allow: ['Edit(*)'], ask: [], deny: ['Edit(secrets/*)'] },
    expected: 'deny',
  },
  {
    name: 'acceptEdits + Edit（无 deny）→ allow',
    tool: EditTool,
    input: { file_path: 'a.ts' },
    mode: 'acceptEdits',
    rules: { allow: [], ask: [], deny: [] },
    expected: 'allow',
  },
  {
    name: 'acceptEdits 仍受 deny 约束 → deny',
    tool: EditTool,
    input: { file_path: 'secrets/k' },
    mode: 'acceptEdits',
    rules: { allow: [], ask: [], deny: ['Edit(secrets/*)'] },
    expected: 'deny',
  },
]

for (const c of cases) {
  test(`checkPermission: ${c.name}`, async () => {
    const { decision } = await checkPermission({
      tool: c.tool,
      input: c.input,
      ctx,
      permissionMode: c.mode,
      rules: c.rules,
    })
    expect(decision).toBe(c.expected)
  })
}
