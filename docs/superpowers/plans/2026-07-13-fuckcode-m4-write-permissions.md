# fuckcode M4 写工具 + 权限 实现计划

> **For agentic workers:** 用 superpowers:subagent-driven-development 执行。

**Goal:** 让模型能改文件（Edit/Write）和跑命令（Bash），并通过权限决策管线对写操作做 ask/deny 控制，让用户在执行前确认危险操作。

**Architecture:** 新增 `src/tools/Write.ts`/`Edit.ts`/`Bash.ts` + `src/tools/_readFileState.ts`（跨工具共享"已读文件"状态）。新增 `src/permissions/`：`rules.ts`（规则解析，`Bash(git *)` 语法）、`decision.ts`（决策管线）、`modes.ts`（PermissionMode）。改造 queryLoop：工具执行前调权限检查，ask 时 yield `permission_request` 等用户回复。改造 Repl：渲染权限弹窗 + resolve。

**前置：** M3 完成（42 tests）

**关键设计（照搬 Claude Code）：**
1. **Edit 写前必读**：readFileState 记录每个文件上次 Read 的 mtime，Edit 前校验"已读 + 未被外部修改"
2. **权限决策顺序**：PermissionMode → deny → allow → 工具内容级 → ask → 默认（只读 allow/写 ask）
3. **规则语法** `Tool(content)`：`Bash(git diff*)` 匹配 `git diff` 和 `git diff --stat`
4. **权限询问是 async**：queryLoop yield permission_request，带 resolve 回调，Repl 弹窗等用户选择后 resolve

---

## 文件结构

```
src/tools/
├── _readFileState.ts    # Task 1 — 跨工具文件已读状态
├── Write.ts             # Task 2 — 整文件重写
├── Edit.ts              # Task 3 — 字符串替换 + 写前必读
└── Bash.ts              # Task 4 — spawn + 超时 + 后台
src/permissions/
├── rules.ts             # Task 5 — 规则解析（Bash(git *) 语法）
├── decision.ts          # Task 6 — 决策管线
└── modes.ts             # Task 5 — PermissionMode 常量
src/agent/queryLoop.ts   # Task 7 — 改造：工具执行前权限检查
src/repl/Repl.tsx        # Task 7 — 改造：权限弹窗
```

---

## Task 1: src/tools/_readFileState.ts

```typescript
// 跨工具共享的"文件已读"状态。Edit/Write 执行前校验：必须先 Read 且文件未被外部修改。
export interface FileReadState {
  mtime: number  // 上次 Read 时的文件 mtimeMs
  readAt: number // 时间戳
}
export type ReadFileState = Map<string, FileReadState>

// 放在 ToolContext 里，跨工具共享同一个 Map 实例
// Read 工具读完更新它；Edit/Write 执行前校验它
```

ToolContext 扩展（在 Tool.ts 里）：加 `readFileState: ReadFileState` 字段。

## Task 2: Write.ts

整文件重写。**必须先 Read**（readFileState 校验）。

```typescript
async execute(input, ctx) {
  const { file_path, content } = input
  // 校验已读
  const state = ctx.readFileState.get(file_path)
  if (!state) return { ok: false, error: '必须先用 Read 读取该文件后才能 Write', isError: true }
  // 原子写（写 .tmp 再 rename）
  await atomicWrite(file_path, content)
  // 更新 readFileState
  ctx.readFileState.set(file_path, { mtime: (await stat(file_path)).mtimeMs, readAt: Date.now() })
  return { ok: true, data: `已写入 ${file_path}（${content.length} 字节）` }
}
```

isReadOnly: false，isConcurrencySafe: false。权限默认 ask。

## Task 3: Edit.ts（字符串替换 + 写前必读）

照设计文档 4.3 节实现。关键：
- 必须先 Read（readFileState 校验）
- 文件未被外部修改（stat.mtimeMs === state.mtime）
- old_string 存在且唯一（多个匹配且非 replace_all 报错）
- 原子写

测试覆盖：写前必读、未读拒绝、唯一性、replace_all、原子写、写入后 readFileState 更新。

## Task 4: Bash.ts

```typescript
async execute(input, ctx) {
  const { command, timeout, run_in_background } = input
  // spawn(command, { shell: true })
  // timeout 默认 120000ms
  // run_in_background: 不等待，立即返回 pid
  // 输出截断：stdout/stderr 各最多 30000 字符
}
```

测试：正常命令、超时、非零退出码、输出截断。本机用 `echo`/`sleep`/`false` 测试。

## Task 5: src/permissions/modes.ts + rules.ts

```typescript
// modes.ts
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

// rules.ts
// 规则字符串格式：ToolName(content?)，如 'Bash(git *)'、'Edit(src/**)'、'Read'
export interface PermissionRule {
  tool: string
  contentPattern?: string  // glob，如 'git *'、'src/**'
}
export function parseRule(rule: string): PermissionRule { /* 解析 'Bash(git *)' */ }
export function matchesRule(rule: PermissionRule, toolName: string, input: unknown): boolean {
  // tool 名匹配 + （如有 contentPattern）针对 input 做内容匹配
  // Bash 匹配 command 字段；Edit/Write 匹配 file_path 字段
}
```

测试：解析各种规则、匹配逻辑（含通配符）。

## Task 6: src/permissions/decision.ts

```typescript
export type PermissionDecision = 'allow' | 'ask' | 'deny'
export async function checkPermission(opts: {
  tool: Tool, input: unknown, ctx: ToolContext,
  permissionMode: PermissionMode,
  rules: { allow: string[]; ask: string[]; deny: string[] }
}): Promise<{ decision: PermissionDecision; reason?: string }> {
  // 1. PermissionMode（bypass → allow；plan + 非只读 → deny）
  // 2. deny 规则
  // 3. allow 规则
  // 4. 工具内容级 checkPermissions
  // 5. ask 规则
  // 6. 默认：只读 allow / 写 ask
}
```

测试：表驱动，覆盖各 PermissionMode × 各规则组合。

## Task 7: queryLoop 接入权限 + Repl 弹窗

### queryLoop 改造

工具执行前调 checkPermission。如果 ask：

```typescript
// 在执行工具前
const perm = await checkPermission({ tool, input, ctx, permissionMode, rules: config.permissions })
if (perm.decision === 'deny') {
  toolResults.push({ toolUseId: tu.id, content: `用户拒绝: ${perm.reason}` })
  yield { type: 'tool_result', tool: tu.name, ok: false, content: `被拒绝` }
  continue
}
if (perm.decision === 'ask') {
  // yield permission_request，等用户 resolve
  const userDecision: PermissionDecision = yield* yieldPermissionRequest(tu.name, input)
  if (userDecision === 'deny') { /* 同上拒绝 */ continue }
}
// allow → 执行
```

`yieldPermissionRequest` 是个 async generator helper：
```typescript
async function* yieldPermissionRequest(tool, input): AsyncGenerator<QueryEvent, PermissionDecision> {
  let resolveFn!: (d: PermissionDecision) => void
  const promise = new Promise<PermissionDecision>(r => resolveFn = r)
  yield { type: 'permission_request', tool, input, resolve: resolveFn }
  return await promise
}
```

QueryEvent 加 `{ type: 'permission_request'; tool: string; input: unknown; resolve: (d: PermissionDecision) => void }`

### Repl 改造

处理 permission_request 事件：渲染弹窗（"Edit 要修改 src/foo.ts，允许？[y/n/always]"），用户按键后 resolve。

M4 简化：弹窗用 Ink 的 useInput 接收 y/n，不画复杂 UI（"always" 选项存入会话级 approved ruleset，但 M4 先只做 y/n）。

## 测试策略

- Write/Edit/Bash：各 4-6 个单元测试（真实文件系统临时目录）
- rules/decision：表驱动测试
- queryLoop：mock LLM 返回 tool_use(Edit)，mock 工具执行，验证权限流程
- 整体目标：M3 的 42 + M4 新增约 20 = 62 tests

## 执行顺序

Task 1-6（工具 + 权限逻辑）相对独立，先做完。Task 7（queryLoop/Repl 集成）是整合点。

## 关键约束

1. **Edit 写前必读是硬护栏**——没有 readFileState 记录就拒绝，绝不盲改
2. **权限默认 fail-safe**：只读 allow，写操作 ask（宁可多问也不误改）
3. **Bash 命令匹配**用通配符，不做 AST 安全分析（Claude Code 的 102KB bashSecurity.ts 太重，M4 用模式匹配）
4. **不要实现"always remember"**（M6 加）：M4 每次 ask 都问
