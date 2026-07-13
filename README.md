# fuckcode

> 原生中文交互的终端 AI 编码工具。目标是从需求到开发测试的完整流程都能在一个工具里完成。

**当前状态：M1 骨架（v0.1.0）** — 空 REPL 已能启动交互，模型接入与工具系统在后续里程碑。

## 快速开始

### 前置要求

- [Bun](https://bun.sh) ≥ 1.2（M1 已实测 bun 1.3.14）
- macOS（M1 仅支持 Mac）

### 安装依赖

```bash
bun install
```

> 本项目默认走国内 npm 镜像（`bunfig.toml` 配了 `registry.npmmirror.com`），如需改回官方源修改 `bunfig.toml`。

### 运行

```bash
# 开发模式（直接跑 TS 源码）
bun run dev

# 通过 bin 入口运行
bun run start

# 显示帮助
bun run dev -- --help
```

进入交互 REPL 后会看到欢迎框，可直接输入文字回车（M1 仅回显，M2 接入模型）。`Ctrl+C` / `Ctrl+D` / `/exit` 退出。

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
  "contextWindow": 200000
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `model` | `claude-sonnet-4-5-20250929` | 模型 ID（M2 接入 Anthropic） |
| `apiKey` | — | Anthropic API Key，也可走 `ANTHROPIC_API_KEY` 环境变量 |
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
| M2 LLM + loop | Anthropic 流式 + queryLoop + 流式渲染 | ⬜ |
| M3 工具系统 | Tool 接口 + Read/Glob/Grep | ⬜ |
| M4 写工具 + 权限 | Write/Edit/Bash + 权限决策管线 | ⬜ |
| M5 会话 + 压缩 | JSONL 存储 + autoCompact | ⬜ |
| M6 打磨发布 | prompt cache + 斜杠命令 + 错误处理 | ⬜ |

完整设计见 [MVP 设计文档](docs/superpowers/specs/2026-07-13-fuckcode-mvp-design.md)，M1 实现计划见 [M1 计划文档](docs/superpowers/plans/2026-07-13-fuckcode-m1-skeleton.md)。

## 参考来源

本项目参考了两个优秀的同类工具，取其精华：

- **Claude Code 逆向源码**（TypeScript + Bun + React/Ink）— 工具接口设计、queryLoop async generator、权限决策管线、FileEdit 写前必读
- **opencode 官方源码**（TypeScript + Bun + Effect.ts）— Effect Service/Layer/Runtime 组织、权限 Deferred 模式

差异化：原生中文交互、中度 Effect 取舍、工作流导向（需求→开发→测试，v1.0）。

## License

私有项目。
