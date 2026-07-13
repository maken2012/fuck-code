# fuckcode

> 原生中文交互的终端 AI 编码工具。目标是从需求到开发测试的完整流程都能在一个工具里完成。

**当前状态：v1.7（217 tests）** — fork history 真继承 + 跨会话输入历史 + LSP 类型诊断。12 个工具。

## 快速开始

### 前置要求

- [Bun](https://bun.sh) ≥ 1.2（M1 已实测 bun 1.3.14）
- macOS（M1 仅支持 Mac）

### 安装依赖

```bash
bun install
```

> 本项目默认走国内 npm 镜像（`bunfig.toml` 配了 `registry.npmmirror.com`），如需改回官方源修改 `bunfig.toml`。

### 设置 API Key（M2 起）

M2 开始需要 Anthropic API Key 才能真实对话。二选一：

```bash
# 方式 1：环境变量（推荐）
export ANTHROPIC_API_KEY=sk-ant-...

# 方式 2：写入配置文件
mkdir -p ~/.fuckcode
echo '{"apiKey":"sk-ant-..."}' > ~/.fuckcode/config.json
```

### 运行

```bash
# 开发模式（直接跑 TS 源码）
bun run dev

# 通过 bin 入口运行
bun run start

# 命令行临时覆盖配置（优先级：flag > 项目 config > 用户 config）
bun run dev -- --model claude-opus-4-1-20250805
bun run dev -- --api-base-url https://your-proxy.com/anthropic --api-key sk-xxx
```

进入交互 REPL 后会看到欢迎框，输入文字回车即可对话（流式显示）。支持多轮上下文。`Ctrl+C` 在生成中中断当前轮次，空闲时退出程序。`/model` 运行时切换模型，`/clear` 清空上下文，`/exit` 退出。

⚠️ fuckcode 需要交互式终端（TTY），不能在管道或重定向 stdin 下运行。

## 配置

配置文件位置（后者覆盖前者）：

- 用户级：`~/.fuckcode/config.json`
- 项目级：`<项目根>/.fuckcode/config.json`

完整字段：

```json
{
  "model": "claude-sonnet-4-5-20250929",
  "apiKey": "sk-ant-...",
  "permissions": {
    "allow": ["Read", "Glob", "Grep", "Bash(git status)"],
    "ask": ["Edit(src/**)"],
    "deny": ["Bash(rm -rf*)", "Edit(.env*)"]
  },
  "permissionMode": "default",
  "maxTokens": 8192,
  "contextWindow": 200000,
  "apiBaseUrl": "https://your-proxy.example.com/anthropic"
}
```

> `apiBaseUrl` 可选，用于第三方 Anthropic 兼容中转（OpenRouter、国内代理等）。不填则直连 `https://api.anthropic.com`。也可走 `ANTHROPIC_BASE_URL` 环境变量。

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `model` | `claude-sonnet-4-5-20250929` | 模型 ID（M2 接入 Anthropic） |
| `apiKey` | — | Anthropic API Key，也可走 `ANTHROPIC_API_KEY` 环境变量 |
| `apiBaseUrl` | — | 第三方兼容 API 的 baseURL（中转/代理），也可走 `ANTHROPIC_BASE_URL` 环境变量 |
| `permissions.allow/ask/deny` | `[]` | 权限规则（M4 实现） |
| `permissionMode` | `default` | `default` / `acceptEdits` / `plan` / `bypassPermissions` |
| `maxTokens` | `8192` | 单次响应最大 token |
| `contextWindow` | `200000` | 上下文窗口大小 |

## 架构

四层（详见 [设计文档](docs/superpowers/specs/2026-07-13-fuckcode-mvp-design.md)）：

```
┌─ TUI 层 (Ink/React) ─ REPL 交互
├─ Agent Loop 层 (async generator) ─ queryLoop + 流式工具执行（M2+）
├─ Service 层 (Effect.ts) ─ Config / Logger / Session / Permission
└─ 工具层 (async) ─ Read/Write/Edit/Bash/Glob/Grep（M3+）
```

**中度 Effect**：Service 层用 Effect.ts 的 Context.Tag + Layer + Runtime 享受组合/重试/资源管理；Agent Loop 与工具用 async generator，照搬 Claude Code 的成熟模式。Service 对外暴露 async API，上层不感知 Effect。

### 代码结构

```
src/
├── cli.tsx              Commander 入口，解析参数启动 REPL
├── version.ts           版本号常量
├── repl/
│   ├── App.tsx          Ink render 入口（startRepl）
│   └── Repl.tsx         REPL 状态机（欢迎语+输入框+回显）
└── services/
    ├── runtime.ts       Effect Runtime 装配中心
    ├── Config.ts        配置加载（Zod 校验 + user/project 合并）
    ├── Logger.ts        stderr 结构化日志
    └── Paths.ts         ~/.fuckcode 路径解析
```

## 开发

```bash
bun test              # 运行测试（M1: 16 tests）
bun run typecheck     # 类型检查（tsc --noEmit）
bun run dev           # 启动 REPL
```

## 路线图

| 里程碑 | 内容 | 状态 |
|--------|------|------|
| **M1 骨架** | Bun 工程 + Effect runtime + Ink REPL + Config/Logger | ✅ |
| **M2 LLM + loop** | Anthropic 流式 + queryLoop + 多轮上下文 + abort | ✅ |
| **M3 工具系统** | Tool 接口 + Read/Glob/Grep + queryLoop 工具循环 | ✅ |
| **M4 写工具 + 权限** | Write/Edit/Bash + 权限决策管线 + ask 弹窗 | ✅ |
| **M5 会话 + 压缩** | JSONL 存储 + 会话恢复 + autoCompact | ✅ |
| **M6 打磨发布** | prompt cache + /cost/help + 网络重试 + 错误加固 | ✅ |
| **v0.2a 一次性模式** | runOnce + stdin 管道 + --plan flag | ✅ |
| **v0.2b plan 计划模式** | /plan 命令 + 五段式实施计划输出 | ✅ |
| **v0.2c Task 子 agent** | 派子 agent 隔离探索/调研（explore/general） | ✅ |
| **v0.3 AGENTS.md** | 项目级指令文件 + /init /agents | ✅ |
| **v1.0 工作流层** | /workflow 四阶段（理解→实现→验证→回顾）★ 核心差异化 | ✅ |
| **v1.1 扩展工具** | TodoWrite + WebSearch/WebFetch + 自定义命令 + 动态工具 | ✅ |
| **v1.2 性能+UX** | 并发执行 + AskUserQuestion + 输入历史 ↑↓ | ✅ |
| **v1.3 Hook 系统** | PreToolUse/PostToolUse/UserPromptSubmit 可扩展 | ✅ |
| **v1.4 生态接入** | MCP 客户端（stdio）+ 多 provider（OpenAI 兼容） | ✅ |
| **v1.5 记忆+压缩** | 记忆系统（memdir）+ microCompact 细粒度压缩 | ✅ |
| **v1.6 安全+增强** | 文件 checkpoint /rewind + 子 agent fork 模式 | ✅ |
| **v1.7 深度增强** | fork history 继承 + 输入历史跨会话 + LSP 诊断工具 | ✅ |
| v1.1+ | MCP 客户端 / 插件系统 / TodoWrite 任务跟踪 | ⬜ |

完整设计见 [MVP 设计文档](docs/superpowers/specs/2026-07-13-fuckcode-mvp-design.md)，M1 实现计划见 [M1 计划文档](docs/superpowers/plans/2026-07-13-fuckcode-m1-skeleton.md)。

## 参考来源

本项目参考了两个优秀的同类工具，取其精华：

- **Claude Code 逆向源码**（TypeScript + Bun + React/Ink）— 工具接口设计、queryLoop async generator、权限决策管线、FileEdit 写前必读
- **opencode 官方源码**（TypeScript + Bun + Effect.ts）— Effect Service/Layer/Runtime 组织、权限 Deferred 模式

差异化：原生中文交互、中度 Effect 取舍、工作流导向（需求→开发→测试，v1.0）。

## License

私有项目。
