# AGENTS.md - fuckcode

> 原生中文、暴躁人格的终端 AI 编码工具。对标 Claude Code / opencode。
> TypeScript + Bun + Effect.ts（中度）+ Ink(React)。

## 常用命令

```bash
bun install              # 装依赖（国内镜像已在 bunfig.toml 配好）
bun run dev              # 启动 REPL（开发模式，直跑 TS）
bun run start            # 通过 bin/fuckcode.js 启动
bun test                 # 全量测试（252 tests）
bun test tests/tools/    # 只跑某目录
bun test tests/llm/anthropic.test.ts  # 单文件
bun run typecheck        # tsc --noEmit（必须 0 错误）
```

## 架构分层（依赖单向向下，严禁反向）

```
TUI 层 (repl/, Ink/React)
  ↓ 调用 queryLoop
Agent 层 (agent/, async generator)  ← queryLoop 是核心循环
  ↓ 调用 streamMessage / 工具 execute
LLM 层 (llm/, provider 路由)  +  工具层 (tools/, 普通 async)
  ↓ 调用 Effect 服务
Service 层 (services/, Effect.ts Context.Tag + Layer)
```

**关键边界**：
- **Effect 不跨层泄漏**：services/ 对外暴露 async 函数（内部 `Effect.runPromise`），上层（agent/repl）不感知 Effect
- **agent loop 是 async generator**：`queryLoop()` 产出 `QueryEvent` 流，TUI `for await` 消费
- **工具不依赖 Effect**：`Tool.execute` 是 `async (input, ctx) => ToolResult`
- **provider.ts 是统一入口**：`streamMessage` 按 model 名路由到 anthropic/openaiCompatible，`streamMessageWithFallback` 包了 fallbackModel 链

## 代码约定（tsconfig 硬约束）

- **`verbatimModuleSyntax: true`**：纯类型 import 必须 `import type { X }`，否则 Bun 运行时报错
- **`noUncheckedIndexedAccess: true`**：`arr[0]` 返回 `T | undefined`，必须处理
- **`jsx: 'react-jsx'`**：无需 `import React`（automatic runtime）
- **路径别名 `@/*` → `src/*`**：import 用 `@/services/Config.js`（ESM 要 .js 后缀，Bun 自动解析到 .ts）
- **测试用 `bun:test`**（不是 vitest）：`import { test, expect } from 'bun:test'`
- **mock 模式**：用 `_llmOverride` / `_clientOverride` / `_queryLoopOverride` 等注入钩子，**不要用 `mock.module`**（会全局污染导致其他测试 fail）

## 关键文件（改动前必读）

| 文件 | 职责 | 改动风险 |
|------|------|------|
| `src/agent/queryLoop.ts` | 主循环（工具执行+权限+压缩+hook） | 核心，改动影响所有功能 |
| `src/llm/provider.ts` | 多 provider 路由 + fallback | 影响所有 LLM 调用 |
| `src/llm/anthropic.ts` | Anthropic 流式（不用 messages.stream，自己累积 block） | content_block_start 要清空 text 防 SDK 重复 |
| `src/repl/Repl.tsx` | Ink REPL（所有命令+渲染+快捷键） | 大文件，改渲染要跑 Repl.test.tsx |
| `src/personality.ts` | 暴躁人格文案（project 灵魂） | 改文案不影响逻辑 |
| `src/tools/registry.ts` | 工具注册（加新工具改这里） | — |
| `src/services/runtime.ts` | Effect Runtime（Layer.toRuntime + Scope） | getRuntime 是 async（ConfigLive 读文件） |

## 设计文档

- `docs/superpowers/specs/2026-07-13-fuckcode-mvp-design.md` — 完整架构设计
- `docs/superpowers/plans/` — 各版本实现计划

## 已知坑

- **Bun 的 `homedir()` 不读 `process.env.HOME`**：Paths.ts 用 `process.env.HOME ?? homedir()`（测试靠覆盖 HOME 隔离）
- **`node:fs/promises.exists` 已废弃**：用 `stat` + try/catch
- **Ink 7 移除了 `lastFrame()`**：测试用 mock stdin/stdout + ANSI 去除（见 tests/repl/Repl.test.tsx 的 renderWithFrame）
- **非 TTY 启动会崩**：App.tsx 有 `process.stdin.isTTY` 检查 + 友好降级
- **Bun shebang 入口**：`bin/fuckcode.js` 显式调 `run()`（不能用 import.meta.main，动态 import 时它是 false）

## 版本

当前 v1.17.0（见 `src/version.ts`）。16 个工具（+NotebookEdit），31 个命令（+/compact /memory /hooks /status /doctor /review /mcp /permissions /add-dir /emacs），362 tests。
