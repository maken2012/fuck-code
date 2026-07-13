# fuckcode MVP 设计文档

- **日期**：2026-07-13
- **状态**：设计稿（待用户复核）
- **作者**：brainstorming 流程产出

---

## 0. 项目定位

**fuckcode** 是一个运行在终端（macOS）的、原生中文交互的 AI 编码工具，目标是从需求到开发测试的完整流程都能在一个工具里完成。终极形态对标 Claude Code / opencode，差异化定位：

1. **原生中文交互**（system prompt、工具描述、界面、错误提示全中文）
2. **工作流导向**：内置"需求拆解 → 计划 → TDD 实现 → 验证"的阶段化流程（MVP 之后的 #11 层）
3. **取两家长处**：Claude Code 的工具/权限/压缩设计 + opencode 的 Effect 服务架构

本设计文档只覆盖 **MVP v0.1（最小可用 agent）**。子 agent / MCP / 插件 / Hook / 工作流层等推迟到后续版本，每个后续版本会有独立 spec。

## 0.1 奠基性决策

| 维度 | 决策 | 理由 |
|------|------|------|
| 技术栈 | TypeScript + Bun + Effect.ts | 与两份参考代码一致，生态成熟 |
| 架构方案 | **中度 Effect**：Service 层用 Effect，agent loop 用 async generator | Service 层享受 Layer 组合/重试/日志，核心循环保持简单可照搬 Claude Code |
| TUI | Ink (React) | 与 Claude Code 泄露代码一致，可直接参考移植 |
| LLM 接入 | 先硬编码 Anthropic（`@anthropic-ai/sdk`） | 最简，未来要加 provider 时再抽象 |
| 界面/prompt 语言 | 中文 | 差异化定位 |
| 项目名 | fuckcode（CLI 命令 `fuckcode`，简称 `fc`） | 用户指定 |
| 平台 | 仅 macOS（v0.1） | 用户指定 |

---

## 1. MVP 范围

### 1.1 成功标准

能跑通这个端到端场景即视为 MVP 完成：

> 在任意代码仓库目录运行 `fuckcode`，进入交互 REPL。输入"把这个函数改成 async 并加上错误处理"，工具会：
> 1. 读取相关文件（Read 工具）
> 2. 修改文件（Edit 工具，字符串替换 + 写前必读）
> 3. 运行测试或 lint（Bash 工具，执行前按权限规则询问）
> 4. 流式展示模型输出 + 工具调用过程
> 5. 中途 Ctrl+C 可中断当前轮次
> 6. 退出后下次进入能恢复历史会话

### 1.2 In-scope（MVP 包含）

- ✅ Bun + TS + Effect.ts 工程骨架，`fuckcode` / `fc` CLI 命令
- ✅ Ink 交互 REPL（输入框、流式输出、工具调用渲染、Ctrl+C/Ctrl+D、权限弹窗）
- ✅ Anthropic 流式调用 + 中文 system prompt + prompt cache
- ✅ Agent loop（async generator + StreamingToolExecutor 简化版）
- ✅ 6 个核心工具：`Read` / `Write` / `Edit` / `Bash` / `Glob` / `Grep`
- ✅ 权限系统（allow/ask/deny 规则 + 交互询问 + PermissionMode）
- ✅ JSONL 会话存储 + 基础 autoCompact（阈值触发摘要）
- ✅ 指令文件（`AGENTS.md`，单文件，不递归向上查找）
- ✅ 配置文件（`~/.fuckcode/config.json` + 项目级 `.fuckcode/config.json`）

### 1.3 Out-of-scope（明确推迟）

- ❌ 多 provider 抽象（v0.2+）
- ❌ 子 agent / Task 工具（v0.2+）
- ❌ MCP 客户端（v0.3+）
- ❌ 插件 / Hook 系统（v0.3+）
- ❌ 工作流层（需求→开发→测试阶段化，v1.0）
- ❌ Web/Desktop UI（v2.0+）
- ❌ 非 Mac 平台
- ❌ microCompact（v0.2+）
- ❌ plan 模式（v0.2+）

---

## 2. 整体架构

### 2.1 分层

四层，依赖单向向下：

```
┌─────────────────────────────────────────────────────┐
│  TUI 层 (Ink/React)                                  │
│  REPL 组件、输入框、流式渲染、工具调用卡片、权限弹窗      │
├─────────────────────────────────────────────────────┤
│  Agent Loop 层 (async generator)                     │
│  queryLoop() — 每轮: 取消息→组装→调LLM→处理tool→回灌   │
│  StreamingToolExecutor — 流式并发执行工具              │
├─────────────────────────────────────────────────────┤
│  Service 层 (Effect.ts: Context.Service + Layer)     │
│  Config / Logger / Session / Permission / ApiClient  │
│  LlmStream (async generator 封装)                    │
├─────────────────────────────────────────────────────┤
│  工具层 (async execute, 普通 TS)                      │
│  Read / Write / Edit / Bash / Glob / Grep            │
│  + Tool 接口 + buildTool 工厂                         │
└─────────────────────────────────────────────────────┘
```

### 2.2 关键边界约定

- **Effect 不跨层泄漏**：Service 层对外暴露普通 async 函数（内部用 `Effect.runPromise` 落地），上层（agent loop、TUI）完全感知不到 Effect
- **agent loop 是 async generator**：`async function* queryLoop()` 产出 `QueryEvent` 流，TUI 层 `for await` 消费渲染
- **工具不依赖 Effect**：`Tool.execute` 是 `async (input, ctx) => ToolResult`，简单直接，照搬 Claude Code

### 2.3 目录结构

```
fuck-code/                         # 工作目录（= npm 包根）
├── package.json                   # bin: { fuckcode: "./bin/fuckcode.js", fc: "./bin/fuckcode.js" }
├── tsconfig.json
├── bunfig.toml
├── bin/
│   └── fuckcode.js                # shebang 入口，转发到 src/cli.tsx
├── src/
│   ├── cli.tsx                    # CLI 参数解析（Commander），启动 REPL 或一次性模式
│   ├── repl/
│   │   ├── App.tsx                # Ink 根组件
│   │   ├── Repl.tsx               # 主 REPL 状态机（输入→queryLoop→渲染）
│   │   ├── components/            # MessageList / InputBox / ToolUseCard / PermissionPrompt / Spinner
│   │   └── hooks/                 # useQueryLoop / useSession / usePermissions
│   ├── agent/
│   │   ├── queryLoop.ts           # ★ 核心 async generator：主循环
│   │   ├── streamingExecutor.ts   # ★ 流式并发工具执行器
│   │   ├── systemPrompt.ts        # 中文 system prompt 组装 + 分段
│   │   └── types.ts               # QueryEvent / Message / ToolUse 等类型
│   ├── services/                  # Effect 服务层
│   │   ├── runtime.ts             # Effect Runtime + Layer 组装（程序入口 bootstrap）
│   │   ├── Config.ts              # 配置加载（user/project/local 三层合并）
│   │   ├── Logger.ts              # 结构化日志（Effect Logger）
│   │   ├── Session.ts             # 会话存储（JSONL 读写 + compact boundary）
│   │   ├── Permission.ts          # 权限规则匹配 + Deferred 询问
│   │   └── ApiClient.ts           # Anthropic 客户端封装（stream 流式 generator）
│   ├── tools/
│   │   ├── Tool.ts                # ★ Tool 接口 + buildTool 工厂
│   │   ├── registry.ts            # 工具注册中心
│   │   ├── Read.ts
│   │   ├── Write.ts
│   │   ├── Edit.ts                # 字符串替换 + 写前必读（readFileState）
│   │   ├── Bash.ts                # spawn + 超时 + 后台进程
│   │   ├── Glob.ts
│   │   ├── Grep.ts
│   │   └── _readFileState.ts      # 跨工具共享的"文件已读"状态
│   ├── permissions/
│   │   ├── rules.ts               # 规则解析（Bash(git *) 语法）
│   │   ├── decision.ts            # ★ hasPermissionToUse 决策管线
│   │   └── modes.ts               # PermissionMode (default/acceptEdits/bypass)
│   ├── config/
│   │   └── schema.ts              # Zod 配置 schema
│   ├── instruction/
│   │   └── agents-md.ts           # AGENTS.md 加载
│   └── utils/
│       ├── tokens.ts              # token 估算
│       ├── paths.ts               # ~/.fuckcode 路径解析
│       └── abort.ts               # AbortController 辅助
├── docs/
│   └── superpowers/specs/
│       └── 2026-07-13-fuckcode-mvp-design.md   # ★ 本设计文档
└── tests/                         # vitest 测试
    ├── tools/
    ├── agent/
    └── permissions/
```

### 2.4 模块依赖关系

| 模块 | 职责 | 依赖 |
|------|------|------|
| `cli.tsx` | 解析参数，决定 REPL/一次性模式，bootstrap Effect runtime | services/runtime, repl |
| `repl/` | Ink UI，消费 `QueryEvent` 流渲染 | agent, services, permissions |
| `agent/queryLoop` | 主循环 async generator，产出事件 | services/ApiClient, services/Session, agent/streamingExecutor |
| `agent/streamingExecutor` | 边 stream 边执行并发安全工具 | tools/*, permissions/decision |
| `services/*` | Effect 服务，对外暴露 async API | 各自依赖 |
| `tools/*` | 工具实现，纯业务逻辑 | utils, tools/_readFileState |
| `permissions/` | 权限决策 | services/Config |

---

## 3. Agent Loop 核心数据流

### 3.1 QueryEvent 类型（TUI 与 agent loop 的契约）

```typescript
// src/agent/types.ts
type QueryEvent =
  | { type: 'text_delta'; text: string }                       // 模型流式文本片段
  | { type: 'tool_use_start'; tool: string; input: unknown }
  | { type: 'tool_use_progress'; tool: string; data: unknown } // 工具进度
  | { type: 'tool_result'; tool: string; toolUseId: string; result: ToolResult }
  | { type: 'permission_request'; tool: string; input: unknown; resolve: (decision) => void }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens: number }
  | { type: 'turn_start'; turn: number }
  | { type: 'turn_end'; turn: number; stopReason: string }
  | { type: 'error'; error: Error; recoverable: boolean }
  | { type: 'done' };
```

### 3.2 queryLoop 主循环伪代码

```typescript
// src/agent/queryLoop.ts
async function* queryLoop(opts: {
  sessionId: string;
  userInput: string;
  tools: Tool[];
  abortSignal: AbortSignal;
}): AsyncGenerator<QueryEvent> {

  let turn = 0;
  let messages = await Session.loadMessages(opts.sessionId);  // 加载历史
  messages.push({ role: 'user', content: opts.userInput });

  while (true) {
    turn++;
    yield { type: 'turn_start', turn };

    // 1. 组装 system prompt（中文，静态段 + 动态段）
    const systemPrompt = buildSystemPrompt({ cwd, tools: opts.tools });

    // 2. autoCompact 检查（阈值 = contextWindow - 13K）
    if (estimateTokens(messages) > getCompactThreshold()) {
      messages = await compactConversation(messages);  // 摘要 + 插 boundary
    }

    // 3. 调 Anthropic 流式 API（async generator）
    const stream = ApiClient.stream({
      model: config.model,            // 默认 claude-sonnet-4-5-20250929
      system: systemPrompt,
      messages,
      tools: opts.tools.map(toAnthropicTool),
      abortSignal: opts.abortSignal,
    });

    // 4. 边 stream 边处理：收集 text + tool_use
    const executor = new StreamingToolExecutor(opts.tools, opts.abortSignal);
    const assistantContent: ContentBlock[] = [];

    for await (const event of stream) {
      if (opts.abortSignal.aborted) throw new AbortError();

      switch (event.type) {
        case 'text_delta':
          yield { type: 'text_delta', text: event.text };
          assistantContent.push({ type: 'text', text: event.text });
          break;

        case 'tool_use_start':
          // ★ 关键：并发安全的工具立即执行（不等 stream 结束）
          const tool = opts.tools.find(t => t.name === event.tool);
          yield* executor.addToolUse(event.toolUseId, tool, event.input);
          assistantContent.push(/* 收集完整 input */);
          break;

        case 'message_delta':
          if (event.usage) yield { type: 'usage', ...event.usage };
          break;
      }
    }

    // 5. 等待所有流式启动的工具完成
    const toolResults = yield* executor.drain();

    // 6. 把 assistant 回复 + tool_result 写入会话
    messages.push({ role: 'assistant', content: assistantContent });
    messages.push({ role: 'user', content: toolResults });
    await Session.appendMessages(opts.sessionId, ...);

    // 7. 判断是否继续下一轮
    if (toolResults.length === 0) {
      yield { type: 'turn_end', turn, stopReason: 'end_turn' };
      yield { type: 'done' };
      return;  // 没有 tool_use，循环结束
    }
    yield { type: 'turn_end', turn, stopReason: 'tool_use' };
    // 有工具调用，继续下一轮让模型看结果
  }
}
```

核心设计点（照搬 Claude Code）：
- `for await ... yield*` 让事件自然向上冒泡，TUI 层拿到就能渲染，无需回调
- **第 4 步的"边 stream 边执行"** 是延迟优化的关键：模型 stream 一个 `Read` 工具用例后，立刻 spawn 执行，等模型 stream 完时结果可能已经回来了
- **第 7 步的循环继续条件**：有 tool_use 就继续，没有就结束。模型自己决定何时停

### 3.3 StreamingToolExecutor 并发模型

```typescript
// src/agent/streamingExecutor.ts
class StreamingToolExecutor {
  private pending: Map<string, Promise<ToolResult>> = new Map();
  private runningConcurrencySafe: Promise<void>[] = [];

  // 流式收到一个 tool_use 时调用
  async *addToolUse(id, tool, input): AsyncGenerator<QueryEvent> {
    // 1. 权限检查（可能 yield permission_request 等用户回复）
    const decision = yield* this.checkPermission(tool, input);
    if (decision === 'deny') {
      yield { type: 'tool_result', tool: tool.name, result: { error: '被拒绝' } };
      return;
    }

    // 2. 执行
    if (tool.isConcurrencySafe?.()) {
      // ★ 并发安全（Read/Glob/Grep）：立即并行跑
      const p = tool.execute(input, this.ctx)
        .then(result => { yield { type: 'tool_result', ... }; });
      this.runningConcurrencySafe.push(p);
    } else {
      // ★ 非并发安全（Write/Edit/Bash）：等当前并发批次完成后再跑
      await Promise.all(this.runningConcurrencySafe);
      this.runningConcurrencySafe = [];
      const result = await tool.execute(input, this.ctx);
      yield { type: 'tool_result', tool: tool.name, result };
    }
  }

  // stream 结束后，等所有流式启动的工具完成
  async *drain(): AsyncGenerator<QueryEvent> {
    await Promise.all(this.runningConcurrencySafe);
    // 按工具调用顺序产出结果（排序保证）
  }
}
```

MVP 简化（相比 Claude Code）：
- Claude Code 有 `partitionToolCalls` 复杂分批 + 最大并发度限制（默认 10）。MVP 用更简单的规则：**只读工具（Read/Glob/Grep）并发，写工具（Write/Edit/Bash）串行**
- 不实现"参数还在 stream 就开始执行"的极限优化（需要解析不完整 JSON），改为"收到完整 tool_use block 后立即执行"——已经能拿到大部分延迟收益

---

## 4. 工具系统与权限

### 4.1 Tool 接口（照搬 Claude Code，简化）

```typescript
// src/tools/Tool.ts
interface Tool<I = unknown, O = unknown> {
  name: string;                              // 'Read' / 'Edit' / ...
  description: string;                       // 给用户看的一行中文说明
  prompt: string;                            // ★ 给模型看的中文详细说明（注入 system prompt）

  inputSchema: ZodSchema<I>;                 // Zod 入参校验

  isReadOnly?: () => boolean;                // 默认 false
  isConcurrencySafe?: () => boolean;         // 默认 false；true 则可并行
  isEnabled?: (ctx) => boolean;              // 默认 true

  validateInput?(input: I, ctx): string | void;           // 校验（权限检查前）
  checkPermissions?(input: I, ctx): PermissionResult;     // 权限检查（内容级）

  execute(input: I, ctx: ToolContext): Promise<ToolResult>; // ★ 执行

  mapResultToModelContent?(result: O): string;  // 结果格式化给模型（控制体积）
}

type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

type ToolContext = {
  cwd: string;
  abortSignal: AbortSignal;
  readFileState: ReadFileState;              // 跨工具共享的"已读文件"状态
  logger: Logger;
};

// 工厂：填充安全默认值（fail-closed）
function buildTool<I, O>(def: Tool<I, O>): Tool<I, O> {
  return {
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    validateInput: () => {},
    checkPermissions: () => ({ decision: 'allow' }),
    ...def,
  };
}
```

### 4.2 六个核心工具属性矩阵

| 工具 | 并发安全 | 权限默认 | 关键设计 |
|------|:---:|------|------|
| **Read** | ✅ | allow（读不危险） | 2000 行限制、图片识别、行号格式（`cat -n`） |
| **Glob** | ✅ | allow | ripgrep 的 glob 语法 |
| **Grep** | ✅ | allow | 调 `rg`，支持 `-i`/`-n`/`-A`/`-B` |
| **Write** | ❌ | **ask**（需用户确认） | 整文件重写，**必须先 Read** |
| **Edit** | ❌ | **ask** | ★ 字符串替换 + **写前必读**（readFileState 时间戳校验） |
| **Bash** | ❌ | **按规则匹配** | spawn + 超时 + `run_in_background` + 输出截断 |

### 4.3 Edit 工具的"写前必读"机制（核心护栏）

```typescript
// src/tools/_readFileState.ts
type ReadFileState = Map<string, { mtime: number; readAt: number }>;
// key = 绝对路径，value = 上次 Read 时的文件 mtime

// Edit.execute 核心校验
async execute(input: EditInput, ctx) {
  const { file_path, old_string, new_string, replace_all } = input;

  // ★ 护栏 1：必须先 Read
  const state = ctx.readFileState.get(file_path);
  if (!state) return { ok: false, error: '必须先用 Read 工具读取该文件后才能编辑' };

  // ★ 护栏 2：文件未被外部修改
  const stat = await fs.stat(file_path);
  if (stat.mtimeMs !== state.mtime) {
    return { ok: false, error: '文件自上次读取后已被外部修改，请重新 Read' };
  }

  // 读取 + 查找 + 唯一性校验
  const content = await fs.readFile(file_path, 'utf8');
  const occurrences = findAll(content, old_string);  // 含引号样式归一化
  if (occurrences.length === 0) return { ok: false, error: 'old_string 在文件中未找到' };
  if (occurrences.length > 1 && !replace_all) {
    return { ok: false, error: `找到 ${occurrences.length} 处匹配，请提供更长的上下文或设 replace_all` };
  }

  // 替换 + 原子写
  const newContent = replace_all
    ? content.split(old_string).join(new_string)
    : content.slice(0, occurrences[0]) + new_string + content.slice(occurrences[0] + old_string.length);
  await atomicWrite(file_path, newContent);  // 写到 .tmp 再 rename

  // 更新 readFileState
  ctx.readFileState.set(file_path, { mtime: (await fs.stat(file_path)).mtimeMs, readAt: Date.now() });
  return { ok: true, data: { path: file_path, replacedCount: replace_all ? occurrences.length : 1 } };
}
```

### 4.4 权限决策管线

```typescript
// src/permissions/decision.ts
async function checkPermission(tool, input, ctx): Promise<PermissionResult> {
  // 1. PermissionMode 优先（bypassPermissions 直接 allow）
  if (ctx.permissionMode === 'bypassPermissions') return { decision: 'allow' };
  if (ctx.permissionMode === 'plan' && !tool.isReadOnly?.()) {
    return { decision: 'deny', reason: 'plan 模式下不允许写操作' };
  }

  // 2. 配置的 deny 规则（整工具级 + 内容级）
  if (matchesRule(ctx.config.permissions.deny, tool.name, input)) {
    return { decision: 'deny', reason: '匹配 deny 规则' };
  }

  // 3. 配置的 allow 规则
  if (matchesRule(ctx.config.permissions.allow, tool.name, input)) {
    return { decision: 'allow' };
  }

  // 4. 工具自己的内容级检查（如 Edit 检查路径、Bash 解析命令）
  const toolDecision = tool.checkPermissions?.(input, ctx);
  if (toolDecision?.decision === 'deny') return toolDecision;

  // 5. 配置的 ask 规则
  if (matchesRule(ctx.config.permissions.ask, tool.name, input)) {
    return { decision: 'ask', reason: '匹配 ask 规则' };
  }

  // 6. 默认策略：只读工具 allow，写工具 ask
  return tool.isReadOnly?.()
    ? { decision: 'allow' }
    : { decision: 'ask' };
}
```

决策顺序：PermissionMode → deny → allow → 工具内容级 → ask → 默认（只读 allow / 写 ask）。

规则语法（照搬 Claude Code 的 `Tool(content)` 格式）：
```
{
  "permissions": {
    "allow": ["Read", "Glob", "Grep", "Bash(git status)", "Bash(git diff*)"],
    "ask":     ["Edit(src/**)", "Write(src/**)"],
    "deny":    ["Bash(rm -rf*)", "Bash(curl*)", "Edit(.env*)"]
  }
}
```

Bash 命令匹配：解析命令首词 + 通配符匹配剩余部分。`Bash(git diff*)` 匹配 `git diff`、`git diff --stat`，不匹配 `git push`。MVP 不做 Claude Code 那套复杂的 AST 安全分析（102KB 的 `bashSecurity.ts`），只做模式匹配 + 用户交互兜底。

### 4.5 权限询问交互

当 `decision === 'ask'` 时：
1. agent loop `yield { type: 'permission_request', ... }`
2. TUI 渲染弹窗：「**Edit** 工具要修改 `src/foo.ts`，是否允许？」+ 选项 `[本次允许 / 永久允许 / 拒绝]`
3. 用户选择后 `resolve(decision)`，agent loop 继续
4. 选"永久允许"则动态写入会话级 ruleset（类似 opencode 的 approved 注入）

---

## 5. 会话、压缩、System Prompt、配置

### 5.1 会话存储（JSONL）

**存储路径**：`~/.fuckcode/projects/<projectHash>/<sessionId>.jsonl`
- `projectHash` = cwd 绝对路径的 hash，隔离不同项目
- 每行一个 JSON 对象（消息），支持流式追加、可 `tail` 查看

**每条消息格式**（Anthropic API 兼容）：
```jsonl
{"role":"user","content":[{"type":"text","text":"帮我改这个函数"}]}
{"role":"assistant","content":[{"type":"text","text":"我先读一下"},{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file_path":"src/foo.ts"}}]}
{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"1: ..."}]}
```

**会话恢复**：启动时读 `<sessionId>.jsonl` 全部行，重建 messages 数组。MVP 不做 sidechain（子 agent 独立 transcript）。

**会话索引**：`~/.fuckcode/projects/<projectHash>/sessions.json` 记录所有 session 元数据（id、createdAt、lastMessage、title），供 `/resume` 命令列出。

### 5.2 autoCompact 压缩（MVP 简化版）

**触发**：每轮 turn 开始前，`estimateTokens(messages) > contextWindow - 13000`（默认 contextWindow = 200000）

**流程**：
1. 调用一个独立的 `compact` 调用（非主对话）：把全部历史 messages 发给模型，prompt = 中文"请把以下对话压缩成摘要，保留关键决策、文件改动、未完成任务"
2. 得到摘要文本
3. 插入一条特殊消息作为 **compact boundary**：
   ```jsonl
   {"role":"user","content":[{"type":"text","text":"<compact>摘要内容</compact>","_meta":{"compactBoundary":true}}]}
   ```
4. 后续 `loadMessages` 只返回 boundary 之后的消息（boundary 本身的摘要作为新上下文起点）

**简化点**：MVP 只做 autoCompact（整段摘要），不做 microCompact。token 估算用"按文件类型 bytes/token 比率"粗估，不调精确 API。

### 5.3 System Prompt（中文，分段 + prompt cache）

**结构**（静态/动态分段，照搬 Claude Code 思想）：

```
[静态段 - 可缓存]
你叫 fuckcode，是一个运行在终端的 AI 编码助手。你会通过工具读取文件、
修改代码、运行命令来帮助用户完成开发任务。

# 核心原则
- 修改文件前必须先 Read
- 优先用 Edit 字符串替换，不要整文件重写
- 运行危险命令前会询问用户
- ...

# 工具使用
## Read
读取文件内容。参数: file_path(必填), offset?, limit?
...
（每个工具的中文 prompt）

[动态段 - 不缓存]
# 当前环境
工作目录: /Users/shun/xxx
操作系统: macOS 15.5
Shell: zsh
Git 分支: main

# 项目指令（AGENTS.md）
（项目级 AGENTS.md 内容，如有）
```

**prompt cache**：调 Anthropic API 时在 system prompt 静态段末尾 + 最后一条 user message 各放一个 `cache_control: { type: 'ephemeral', ttl: '1h' }`。静态段稳定后跨轮次命中，省钱省延迟。

### 5.4 配置系统

**配置文件路径**：
- 用户级：`~/.fuckcode/config.json`
- 项目级：`<cwd>/.fuckcode/config.json`（覆盖用户级，深合并）

**Schema**：
```typescript
const ConfigSchema = z.object({
  model: z.string().default('claude-sonnet-4-5-20250929'),
  apiKey: z.string().optional(),           // 也可走 ANTHROPIC_API_KEY 环境变量
  permissions: z.object({
    allow: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  }).default({}),
  permissionMode: z.enum(['default','acceptEdits','plan','bypassPermissions']).default('default'),
  maxTokens: z.number().default(8192),
  contextWindow: z.number().default(200000),
}).default({});
```

**API Key 优先级**：`config.apiKey` > `ANTHROPIC_API_KEY` 环境变量 > 报错引导用户配置。

---

## 6. TUI、Effect 服务、错误、测试、里程碑

### 6.1 Ink REPL 交互

```tsx
// src/repl/App.tsx
render(
  <ThemeProvider>
    <Repl runtime={runtime} sessionId={sessionId} />
  </ThemeProvider>
);

// src/repl/Repl.tsx
function Repl({ runtime, sessionId }) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController>();

  async function onSubmit(text: string) {
    if (text.startsWith('/')) return handleSlashCommand(text);

    setRunning(true);
    abortRef.current = new AbortController();

    const loop = queryLoop({ sessionId, userInput: text, tools, abortSignal: abortRef.current.signal });

    try {
      for await (const event of loop) {
        switch (event.type) {
          case 'text_delta':     appendToLastAssistant(event.text); break;
          case 'tool_use_start': pushToolUseCard(event); break;
          case 'tool_result':    updateToolResult(event); break;
          case 'permission_request':
            const decision = await showPermissionDialog(event);  // 弹窗阻塞
            event.resolve(decision);
            break;
          case 'turn_end':       flush(); break;
          case 'done':           break;
          case 'error':          showError(event.error); break;
        }
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <Box flexDirection="column">
      <MessageList messages={messages} />
      <InputBox value={input} onChange={setInput} onSubmit={onSubmit} disabled={running} />
      {running && <Hint text="Ctrl+C 中断 / Ctrl+D 退出" />}
    </Box>
  );
}
```

关键交互：
- **流式渲染**：`text_delta` 累积到最后一个 assistant 消息，实时刷新
- **Ctrl+C**：触发 `abortRef.current.abort()`，queryLoop 在下个 `for await` 抛 AbortError，被 catch 后优雅结束当前轮次（保留已产生的内容）
- **工具调用卡片**：每个 tool_use 渲染为一个折叠卡片，显示工具名、入参摘要、结果
- **权限弹窗**：Ink 绝对定位覆盖在底部，三个选项按钮

斜杠命令（MVP 内置 5 个）：
- `/clear` — 清空当前会话上下文（不删文件）
- `/help` — 显示帮助
- `/cost` — 显示本次会话 token 用量
- `/resume` — 列出历史会话并恢复
- `/exit` — 退出

### 6.2 Effect 服务层落地（中度用法）

```typescript
// src/services/runtime.ts — 程序入口 bootstrap
import { Effect, Layer, Runtime } from 'effect';

// 1. 定义每个 Service 的 Tag
class Config extends Context.Tag('Config')<Config, Config.Service>() {}
class Logger extends Context.Tag('Logger')<Logger, Logger.Service>() {}
class Session extends Context.Tag('Session')<Session, Session.Service>() {}

// 2. 各 Service 的实现 Layer
const ConfigLive = Layer.effect(Config, Config.make());      // 读配置文件
const LoggerLive = Layer.sync(Logger, () => makeLogger());   // 控制台/文件日志
const SessionLive = Layer.effect(Session, Session.make());   // JSONL 会话

// 3. 组装主 Layer
const MainLive = Layer.mergeAll(ConfigLive, LoggerLive, SessionLive, ...);

// 4. 构建 Runtime（程序启动时一次）
export const runtime = MainLive.pipe(Runtime.make);

// src/services/Session.ts — 对外暴露 async API（隐藏 Effect）
export namespace Session {
  export interface Service {
    readonly loadMessages: (sessionId: string) => Promise<Message[]>;
    readonly append: (sessionId: string, ...msgs: Message[]) => Promise<void>;
  }
  const make = (): Effect.Effect<Service> =>
    Effect.gen(function* () {
      const config = yield* Config;
      const logger = yield* Logger;
      return {
        loadMessages: (sid) => Effect.runPromise(_loadMessages(sid).pipe(
          Effect.provideService(Logger, logger),
        )),
        append: (sid, ...msgs) => Effect.runPromise(_append(sid, ...msgs).pipe(
          Effect.provideService(Logger, logger),
          Effect.retry(Schedule.exponential('1 seconds').pipe(Schedule.upTo('30 seconds'))),
        )),
      };
    });
}
```

**关键约定**：Service 对外暴露**普通 async 函数**（内部 `Effect.runPromise`），上层（agent loop、TUI）完全用 async/await，**感知不到 Effect**。Effect 只在 Service 内部用，享受：重试（Schedule）、结构化日志（Logger）、资源管理（Scope/acquireRelease，MVP 暂不深度用）。

### 6.3 错误处理策略

| 错误类型 | 处理 |
|------|------|
| **API 网络错误 / 超时** | Effect.retry 指数退避（Service 层），3 次失败后 `yield error{recoverable:false}`，TUI 显示并停止 |
| **API 429 限流** | 同上重试，带 `retry-after` |
| **prompt too long** | 触发强制 autoCompact 后重试（queryLoop 内） |
| **工具执行错误**（命令失败、文件不存在） | 返回 `{ ok: false, error }` 给模型，让模型自己决定下一步 |
| **权限被拒** | 返回 `tool_result` 告知模型"用户拒绝了此操作"，模型调整策略 |
| **AbortError**（Ctrl+C） | catch 后保留已产生内容，结束当前轮次，REPL 回到输入态 |
| **未知异常** | `yield error{recoverable:false}`，打印完整堆栈，停止当前 queryLoop |

### 6.4 测试策略

- **vitest** 作为测试框架
- **工具层**：单元测试为主。Edit 的"写前必读"、唯一性校验、replace_all、原子写都测；Bash 的超时/后台进程测；权限规则匹配测
- **权限决策管线**：表驱动测试，覆盖 deny/allow/ask/默认策略/各 PermissionMode
- **queryLoop**：mock ApiClient（返回预录制的流式事件序列），验证事件流正确性、autoCompact 触发、工具结果回灌
- **会话存储**：真实文件系统（临时目录），验证 JSONL 读写、compact boundary 恢复
- **E2E**（最少一个）：起 REPL，模拟用户输入，验证"读文件→改文件→跑测试"闭环（用 mock API）
- **目标覆盖率**：核心模块（tools/、permissions/、agent/queryLoop）> 80%

### 6.5 实现里程碑（MVP v0.1 拆解）

| 阶段 | 产出 | 可验证状态 |
|------|------|------|
| **M1 骨架** | Bun+TS 工程、Effect runtime bootstrap、Ink 空 REPL、`fuckcode` 命令能启动 | 跑 `fuckcode` 进入空白交互界面 |
| **M2 LLM + 基础 loop** | ApiClient 流式调用、queryLoop 骨架（无工具）、流式文本渲染 | 输入"你好"能流式回复 |
| **M3 工具系统** | Tool 接口 + buildTool + Read/Glob/Grep（只读工具） | 能让模型读文件、搜索代码 |
| **M4 写工具 + 权限** | Write/Edit/Bash + 权限决策管线 + 权限弹窗 | 能改文件、跑命令，危险操作会问 |
| **M5 会话 + 压缩** | JSONL 存储 + 会话恢复 + autoCompact | 退出重进能恢复，长对话能压缩 |
| **M6 打磨** | system prompt 中文化、prompt cache、斜杠命令、错误处理、测试补齐 | 端到端跑通"改代码+跑测试" |

---

## 7. 后续演进路径（非本 spec 范围，仅供规划参考）

| 版本 | 主题 | 内容 |
|------|------|------|
| v0.2 | 扩展能力 | 子 agent / Task 工具、plan 模式、microCompact、多 provider 抽象 |
| v0.3 | 生态 | MCP 客户端、插件 / Hook 系统、Skill 系统 |
| v1.0 | 工作流层 | "需求→计划→TDD→验证"阶段化流程（核心差异化） |
| v2.0+ | 多端 | Web / Desktop UI、Linux/Windows 支持 |

每个后续版本会有独立 spec，按 brainstorming → writing-plans → executing-plans 流程推进。

---

## 8. 参考来源

- **Claude Code 逆向源码**：`/Users/shun/Documents/GitHub/pengchengneo/Claude-Code`（TypeScript + Bun + React/Ink）
  - 借鉴：Tool 接口 + buildTool、queryLoop async generator、StreamingToolExecutor、权限决策管线、FileEdit 字符串替换 + 写前必读、JSONL 会话 + autoCompact、system prompt 分段缓存
- **opencode 官方源码**：`/Users/shun/Documents/GitHub/anomalyco/opencode`（TypeScript + Bun + Effect.ts + OpenTUI）
  - 借鉴：Effect.ts 的 Service/Layer/Runtime 组织、权限 Deferred 模式、AGENTS.md 向上查找注入
- 本 spec 差异化：原生中文交互、中度 Effect 取舍（Service 用 Effect / loop 用 async generator）、MVP 范围裁剪
