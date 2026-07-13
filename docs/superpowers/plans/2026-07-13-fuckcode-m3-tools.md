# fuckcode M3 工具系统实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 让模型能调用只读工具（Read 读文件、Glob 找文件、Grep 搜内容）读取代码——实现"用户说'看看 src/foo.ts'→模型调 Read→显示文件内容"的闭环。

**Architecture:** 新增 `src/tools/`：`Tool.ts`（接口 + buildTool 工厂，照搬 Claude Code）、`registry.ts`（注册中心）、`Read.ts`/`Glob.ts`/`Grep.ts`（三个只读工具）。改造 `src/agent/queryLoop.ts`：从 M2 的单轮扩展成 while 循环（有 tool_use 就执行工具→回灌 tool_result→继续下一轮，直到模型不再调工具）。改造 `src/llm/anthropic.ts`：支持 tools 参数 + 解析 tool_use 事件。更新 systemPrompt 加入工具说明。

**Tech Stack:** 复用 M1+M2 全部 + Grep/Glob 用 `rg`（ripgrep，本机已装）

**前置：** M2 完成（22 tests PASS）

**关键设计（照搬 Claude Code）：**
1. `Tool<I,O>` 接口：name/description/prompt/inputSchema(Zod)/isReadOnly/isConcurrencySafe/execute
2. `buildTool` 工厂填充安全默认值（isReadOnly 默认 false，只读工具显式设 true）
3. queryLoop 扩展为 while 循环：模型返回 tool_use → 执行 → tool_result 拼回 messages → 继续
4. 工具用普通 async，不依赖 Effect（中度 Effect 边界）

---

## 文件结构

```
src/tools/
├── Tool.ts          # Task 1 — Tool 接口 + buildTool 工厂
├── registry.ts      # Task 1 — 工具注册中心
├── Read.ts          # Task 2 — 读文件工具
├── Glob.ts          # Task 3 — glob 找文件工具
└── Grep.ts          # Task 3 — rg 搜索工具
src/llm/anthropic.ts # Task 4 — 改造：支持 tools + tool_use 事件
src/agent/queryLoop.ts # Task 4 — 改造：while 循环 + 工具执行
src/agent/systemPrompt.ts # Task 5 — 更新：注入工具说明
tests/tools/Read.test.ts   # Task 2
tests/tools/Grep.test.ts   # Task 3
tests/agent/queryLoop.test.ts # Task 4 — 扩展：工具调用循环测试
```

---

## Task 1: src/tools/Tool.ts + src/tools/registry.ts

### Step 1: 写 src/tools/Tool.ts

```typescript
// src/tools/Tool.ts
// Tool 接口 + buildTool 工厂。照搬 Claude Code 设计（简化）。
// 工具用普通 async，不依赖 Effect——中度 Effect 架构里工具层是纯业务逻辑。
import type { z } from 'zod'

export interface ToolContext {
  cwd: string
  abortSignal: AbortSignal
}

export type ToolResult =
  | { ok: true; data: unknown; isError?: false }
  | { ok: false; error: string; isError: true }

// 工具接口（泛型 I=入参, O=输出）
export interface Tool<I = unknown> {
  name: string                          // 'Read' / 'Glob' / 'Grep' ...
  description: string                   // 给用户看的一行中文说明
  prompt: string                        // 给模型看的中文详细说明（注入 system prompt）
  inputSchema: z.ZodType<I>             // Zod 入参校验

  isReadOnly?: () => boolean            // 默认 false（buildTool 填充）
  isConcurrencySafe?: () => boolean     // 默认 false；true 可并行执行

  // 执行：入参 + 上下文 → 结果
  execute(input: I, ctx: ToolContext): Promise<ToolResult>

  // 把结果格式化给模型看（控制体积，超限截断）
  formatResult?(data: unknown): string
}

// 工厂：填充安全默认值（fail-closed）
export function buildTool<I>(def: Tool<I>): Tool<I> {
  return {
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    formatResult: (data) => (typeof data === 'string' ? data : JSON.stringify(data, null, 2)),
    ...def,
  }
}
```

### Step 2: 写 src/tools/registry.ts

```typescript
// src/tools/registry.ts
// 工具注册中心。收集所有工具，供 queryLoop 使用。
import type { Tool } from '@/tools/Tool.js'
import { ReadTool } from '@/tools/Read.js'
import { GlobTool } from '@/tools/Glob.js'
import { GrepTool } from '@/tools/Grep.js'

// 所有内置工具（M3 只读三件套；M4 加 Write/Edit/Bash）
export function getAllTools(): Tool[] {
  return [ReadTool, GlobTool, GrepTool]
}

// 按名字查找
export function findTool(name: string, tools: Tool[]): Tool | undefined {
  return tools.find((t) => t.name === name)
}

// 转成 Anthropic API 的 tools 参数格式
export function toolsToAnthropicFormat(tools: Tool[]): object[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.prompt,
    input_schema: zodToJsonSchema(t.inputSchema),
  }))
}

// 极简 Zod → JSON Schema（M3 用，zod-to-json-schema 依赖 M6 再加）
// 只支持 Read/Glob/Grep 用到的：object + string + number 字段 + optional
function zodToJsonSchema(schema: z.ZodType): object {
  // Zod 3 的 _def 结构。M3 用一个简化版：手动给每个工具写 JSON Schema 更可靠
  // 实际上 Read/Glob/Grep 直接在文件里 export 自己的 JSON Schema 更简单
  // 这里返回空对象，让各工具自己覆盖 toAnthropicFormat
  return { type: 'object', properties: {}, additionalProperties: true }
}
```

⚠️ `zodToJsonSchema` 很难写得通用。**更稳的方案**：每个 Tool 额外导出一个 `anthropicToolDef`（直接写 JSON Schema），registry 直接用它。我会在 Task 2/3 里给每个工具加这个。简化 registry：

```typescript
// src/tools/registry.ts（简化版——用工具自带的 jsonSchema）
export function getAllTools(): Tool[] {
  return [ReadTool, GlobTool, GrepTool]
}
export function findTool(name: string, tools: Tool[]): Tool | undefined {
  return tools.find((t) => t.name === name)
}
export function toolsToAnthropicFormat(tools: Tool[]): object[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.prompt,
    input_schema: (t as Tool & { jsonSchema?: object }).jsonSchema ?? { type: 'object', properties: {} },
  }))
}
```

各工具自带 `jsonSchema` 静态字段。

- [ ] **Step 1-2: 写 Tool.ts + registry.ts**
- [ ] **Step 3: typecheck（依赖的 Read/Glob/Grep 还没写，预期报找不到）**
- [ ] **Step 4: Commit（先提交，Task 2-3 实现依赖后通过）**

---

## Task 2: src/tools/Read.ts（读文件工具 + 测试）

### Step 1: 写测试 tests/tools/Read.test.ts

```typescript
// tests/tools/Read.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ReadTool } from '@/tools/Read.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-read-test-' + process.pid)

beforeEach(async () => {
  await mkdir(tmpDir, { recursive: true })
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

test('读取存在的文件', async () => {
  const filePath = resolve(tmpDir, 'foo.ts')
  await writeFile(filePath, 'const x = 1\nconst y = 2\n')
  const result = await ReadTool.execute(
    { file_path: filePath },
    { cwd: tmpDir, abortSignal: new AbortController().signal },
  )
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.data).toContain('const x = 1')
    expect(result.data).toContain('1\tconst x = 1') // 行号格式
  }
})

test('文件不存在返回错误', async () => {
  const result = await ReadTool.execute(
    { file_path: resolve(tmpDir, 'nope.ts') },
    { cwd: tmpDir, abortSignal: new AbortController().signal },
  )
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toMatch(/不存在|not exist|ENOENT/i)
})

test('支持 offset + limit', async () => {
  const filePath = resolve(tmpDir, 'lines.txt')
  await writeFile(filePath, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'))
  const result = await ReadTool.execute(
    { file_path: filePath, offset: 10, limit: 5 },
    { cwd: tmpDir, abortSignal: new AbortController().signal },
  )
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.data).toContain('line 10')
    expect(result.data).toContain('line 14')
    expect(result.data).not.toContain('line 15') // limit 5: 10-14
  }
})

test('isReadOnly 和 isConcurrencySafe 都是 true', () => {
  expect(ReadTool.isReadOnly?.()).toBe(true)
  expect(ReadTool.isConcurrencySafe?.()).toBe(true)
})
```

### Step 2: 写实现 src/tools/Read.ts

```typescript
// src/tools/Read.ts
// 读文件工具。加行号（cat -n 格式）。支持 offset/limit。
// 默认最多 2000 行。
import { readFile, stat } from 'node:fs/promises'
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'

const ReadInput = z.object({
  file_path: z.string().describe('要读取的文件绝对路径'),
  offset: z.number().int().positive().optional().describe('起始行号（1-based）'),
  limit: z.number().int().positive().optional().describe('读取行数（默认 2000）'),
})
type ReadInputType = z.infer<typeof ReadInput>

export const ReadTool = buildTool<ReadInputType>({
  name: 'Read',
  description: '读取文件内容',
  prompt: `读取文件内容，按行号格式输出（cat -n 风格）。

参数：
- file_path（必填）：文件绝对路径
- offset（可选）：起始行号，1-based
- limit（可选）：读取行数，默认 2000

用途：查看源码、配置文件、日志等文本文件。默认读前 2000 行。`,
  inputSchema: ReadInput,
  jsonSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '要读取的文件绝对路径' },
      offset: { type: 'integer', minimum: 1, description: '起始行号（1-based）' },
      limit: { type: 'integer', minimum: 1, description: '读取行数（默认 2000）' },
    },
    required: ['file_path'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async execute(input, ctx) {
    try {
      const stats = await stat(input.file_path)
      if (!stats.isFile()) {
        return { ok: false, error: `${input.file_path} 不是文件（可能是目录）`, isError: true }
      }
      const content = await readFile(input.file_path, 'utf8')
      const lines = content.split('\n')
      // 去掉末尾空行（文件以 \n 结尾产生的）
      if (lines[lines.length - 1] === '' && lines.length > 1) lines.pop()

      const offset = input.offset ?? 1
      const limit = input.limit ?? 2000
      const start = Math.max(0, offset - 1)
      const end = Math.min(lines.length, start + limit)
      const slice = lines.slice(start, end)

      // cat -n 格式：行号右对齐 6 宽 + tab + 内容
      const numbered = slice
        .map((line, i) => `${String(start + i + 1).padStart(6, ' ')}\t${line}`)
        .join('\n')

      const totalLines = lines.length
      const shownRange = `${start + 1}-${end}`
      const summary = `\n（共 ${totalLines} 行，显示 ${shownRange}）`

      return { ok: true, data: numbered + summary }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        return { ok: false, error: `文件不存在: ${input.file_path}`, isError: true }
      }
      return { ok: false, error: `读取失败: ${err.message}`, isError: true }
    }
  },
})
```

- [ ] **Step 1-2: 测试（红）→ 实现（绿）**
- [ ] **Step 3: typecheck + 测试通过**
- [ ] **Step 4: Commit**

---

## Task 3: src/tools/Glob.ts + src/tools/Grep.ts

### Glob.ts（找文件）

```typescript
// src/tools/Glob.ts
// 用 Bun 的 Glob（内置）或 Bash 的 find。M3 用简单版：递归匹配。
import { glob } from 'node:fs/promises'  // Bun 支持，或用 fast-glob
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'

// ⚠️ Bun 1.3 的 fs/promises 可能没有 glob。用 Bun.Glob 替代。
const GlobInput = z.object({
  pattern: z.string().describe('glob 模式，如 **/*.ts'),
  path: z.string().optional().describe('搜索目录，默认 cwd'),
})
type GlobInputType = z.infer<typeof GlobInput>

export const GlobTool = buildTool<GlobInputType>({
  name: 'Glob',
  description: '按 glob 模式查找文件',
  prompt: `按 glob 模式递归查找文件路径。

参数：
- pattern（必填）：glob 模式，如 "**/*.ts"、"src/**/*.test.ts"
- path（可选）：搜索根目录，默认当前工作目录

返回匹配的文件路径列表（相对路径）。`,
  inputSchema: GlobInput,
  jsonSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式' },
      path: { type: 'string', description: '搜索目录（默认 cwd）' },
    },
    required: ['pattern'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async execute(input, ctx) {
    try {
      // Bun.Glob（运行时原生）
      const g = new Bun.Glob(input.pattern)
      const root = input.path ?? ctx.cwd
      const matches: string[] = []
      for await (const path of g.scan({ cwd: root, absolute: false })) {
        matches.push(path)
      }
      if (matches.length === 0) {
        return { ok: true, data: '（无匹配文件）' }
      }
      matches.sort()
      const limited = matches.slice(0, 100)
      const summary = limited.length < matches.length ? `\n（共 ${matches.length} 个，显示前 100）` : ''
      return { ok: true, data: limited.join('\n') + summary }
    } catch (e) {
      return { ok: false, error: `Glob 失败: ${(e as Error).message}`, isError: true }
    }
  },
})
```

### Grep.ts（用 ripgrep 搜内容）

```typescript
// src/tools/Grep.ts
// 调用 ripgrep（rg）搜索文件内容。本机已装 rg。
import { spawn } from 'node:child_process'
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'

const GrepInput = z.object({
  pattern: z.string().describe('正则表达式或搜索词'),
  path: z.string().optional().describe('搜索目录，默认 cwd'),
  glob: z.string().optional().describe('文件类型过滤，如 *.ts'),
  ignore_case: z.boolean().optional().describe('忽略大小写'),
})
type GrepInputType = z.infer<typeof GrepInput>

export const GrepTool = buildTool<GrepInputType>({
  name: 'Grep',
  description: '搜索文件内容（ripgrep）',
  prompt: `用 ripgrep 搜索文件内容，返回匹配的行（带文件名和行号）。

参数：
- pattern（必填）：搜索词或正则表达式
- path（可选）：搜索目录，默认 cwd
- glob（可选）：文件过滤，如 "*.ts"
- ignore_case（可选）：忽略大小写

返回格式：file:line:content。`,
  inputSchema: GrepInput,
  jsonSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      glob: { type: 'string' },
      ignore_case: { type: 'boolean' },
    },
    required: ['pattern'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async execute(input, ctx) {
    return new Promise((resolve) => {
      const args = ['--line-number', '--no-heading', '--color=never']
      if (input.ignore_case) args.push('-i')
      if (input.glob) args.push('-g', input.glob)
      args.push(input.pattern)
      args.push(input.path ?? ctx.cwd)

      const proc = spawn('rg', args, { cwd: ctx.cwd })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (d) => (stdout += d.toString()))
      proc.stderr.on('data', (d) => (stderr += d.toString()))
      proc.on('error', (e) => {
        resolve({ ok: false, error: `rg 启动失败（可能未装 ripgrep）: ${e.message}`, isError: true })
      })
      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ ok: true, data: stdout.trim() || '（无匹配）' })
        } else if (code === 1) {
          resolve({ ok: true, data: '（无匹配）' })  // rg 退出码 1 = 无匹配
        } else {
          resolve({ ok: false, error: stderr || `rg 退出码 ${code}`, isError: true })
        }
      })
    })
  },
})
```

### 测试 tests/tools/Grep.test.ts（Glob 测试类似，省略）

```typescript
// tests/tools/Grep.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { GrepTool } from '@/tools/Grep.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-grep-test-' + process.pid)
beforeEach(async () => {
  await mkdir(tmpDir, { recursive: true })
  await writeFile(resolve(tmpDir, 'a.ts'), 'const hello = "world"\nconst foo = 1\n')
  await writeFile(resolve(tmpDir, 'b.ts'), 'export const hello = () => 2\n')
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

test('搜索到匹配行', async () => {
  const result = await GrepTool.execute(
    { pattern: 'hello' },
    { cwd: tmpDir, abortSignal: new AbortController().signal },
  )
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.data).toMatch(/hello/)
    expect(result.data).toMatch(/a\.ts/)
    expect(result.data).toMatch(/b\.ts/)
  }
})

test('无匹配返回友好提示', async () => {
  const result = await GrepTool.execute(
    { pattern: 'zzz_not_exist' },
    { cwd: tmpDir, abortSignal: new AbortController().signal },
  )
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.data).toMatch(/无匹配/)
})
```

- [ ] **Step 1-3: 写 Glob + Grep + Grep 测试（红→绿）**
- [ ] **Step 4: typecheck + 全测试**
- [ ] **Step 5: Commit**

---

## Task 4: 改造 queryLoop + anthropic 支持工具调用（核心）

这是 M3 最核心的改动。queryLoop 从 M2 的单轮扩展成 while 循环。

### 改造 src/llm/anthropic.ts

LlmEvent 增加 tool_use 相关事件：

```typescript
// src/llm/types.ts 追加
export type LlmEvent =
  | { type: 'text'; textDelta: string }
  | { type: 'tool_use'; toolName: string; toolUseId: string; input: unknown }
  | { type: 'usage'; input: number; output: number; cacheRead: number }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; error: Error }
```

anthropic.ts 增加：
- `StreamAnthropicOpts` 增加 `tools?: object[]`
- 解析 `content_block_start` 的 `type === 'tool_use'`（累积 name/id）
- 解析 `content_block_delta` 的 `type === 'input_json_delta'`（累积 input JSON 碎片）
- `content_block_stop` 时：如果是 tool_use block，解析完整 input JSON，yield tool_use 事件

### 改造 src/agent/queryLoop.ts

```typescript
// queryLoop 改造为 while 循环
export async function* queryLoop(opts: QueryLoopOpts): AsyncGenerator<QueryEvent> {
  const tools = opts.tools ?? []
  let messages: ChatMessage[] = [...opts.history, { role: 'user', content: opts.userInput }]
  let turn = 0
  const MAX_TURNS = 20  // 防止无限循环

  while (turn < MAX_TURNS) {
    turn++
    let assistantText = ''
    const toolUses: { id: string; name: string; input: unknown }[] = []

    // 调 LLM
    for await (const event of streamFn({ model, system, messages, tools: toolsToAnthropicFormat(tools), signal, ... })) {
      switch (event.type) {
        case 'text':
          assistantText += event.textDelta
          yield { type: 'text_delta', text: event.textDelta }
          break
        case 'tool_use':
          toolUses.push({ id: event.toolUseId, name: event.toolName, input: event.input })
          yield { type: 'tool_use_start', tool: event.toolName, input: event.input }
          break
        case 'usage':
          yield { type: 'usage', ... }
          break
        case 'done':
          // 记录 stopReason
          break
      }
    }

    // 把 assistant 回复加入 messages
    messages.push({ role: 'assistant', content: assistantText || /* 含 tool_use 时的结构化 content */ })

    if (toolUses.length === 0) {
      // 没有工具调用，本轮结束
      yield { type: 'turn_end', stopReason }
      yield { type: 'done' }
      return
    }

    // 执行所有工具，收集结果
    const toolResults = []
    for (const tu of toolUses) {
      const tool = findTool(tu.name, tools)
      if (!tool) {
        toolResults.push({ toolUseId: tu.id, content: `错误：未知工具 ${tu.name}` })
        continue
      }
      yield { type: 'tool_executing', tool: tu.name }
      const result = await tool.execute(tu.input, { cwd: opts.cwd, abortSignal: opts.signal })
      const content = result.ok
        ? (tool.formatResult ? tool.formatResult(result.data) : JSON.stringify(result.data))
        : `错误: ${result.error}`
      toolResults.push({ toolUseId: tu.id, content })
      yield { type: 'tool_result', tool: tu.name, result: content, ok: result.ok }
    }

    // 把 tool_result 拼回 messages，继续下一轮
    messages.push({ role: 'user', content: /* tool_result 结构化 */ })
    yield { type: 'turn_end', stopReason: 'tool_use' }
  }

  yield { type: 'error', error: new Error('达到最大轮次限制'), recoverable: true }
  yield { type: 'done' }
}
```

⚠️ **关键复杂点**：Anthropic API 的 messages 格式在有 tool_use 时是**结构化 content**（数组，含 text block 和 tool_use block），tool_result 也是结构化。M2 的 `ChatMessage.content: string` 不够用了。

**方案**：M3 把 ChatMessage.content 改成 `string | ContentBlock[]`，ContentBlock 支持 text/tool_use/tool_result。anthropic.ts 和 queryLoop.ts 都要处理这个。这是 M3 最大的改动量。

### 测试

扩展 tests/agent/queryLoop.test.ts：mock 一个会先调 Read 工具再回复的 LLM 响应，验证：
- 第一轮 yield tool_use_start
- 执行 Read（mock 文件系统）
- 第二轮 LLM 看到工具结果后回复文本
- 最终 yield done

- [ ] **Step 1-4: 改造 types + anthropic + queryLoop + 测试**
- [ ] **Step 5: Commit**

---

## Task 5: 更新 systemPrompt + Repl 接入工具

### systemPrompt.ts 更新

注入工具说明（遍历 tools，把每个 tool.prompt 拼进 system prompt）。

### Repl.tsx 更新

queryLoop 现在会 yield `tool_use_start` / `tool_result` 事件，Repl 需要渲染它们（简单显示"📖 Read src/foo.ts" + 折叠结果）。

- [ ] **Step 1-2: 更新 systemPrompt + Repl**
- [ ] **Step 3: 全测试 + typecheck**
- [ ] **Step 4: Commit**

---

## Task 6: E2E + README + M3 自检

- [ ] **Step 1: E2E（需 API key + TTY）**：输入"读一下 src/version.ts"→模型应调 Read → 显示文件内容
- [ ] **Step 2: README M3 ✅**
- [ ] **Step 3: M3 自检（全测试 + typecheck）**

---

## 执行注意事项

1. **ContentBlock 结构化**是 M3 最大改动——M2 的 string content 要升级成 union
2. **MAX_TURNS 防死循环**：模型可能无限调工具，硬限制 20 轮
3. **工具执行错误不终止循环**：返回错误信息给模型，让它自己调整
4. **abort 要穿透工具执行**：工具 execute 应响应 ctx.abortSignal
5. **不要提前实现权限**（M4）：M3 所有工具默认 allow（只读工具本就安全）
