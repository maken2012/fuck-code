<div align="center">

```
  ███████╗ ██╗   ██╗  ██████╗  ██╗  ██╗  ██████╗   ██████╗  ██████╗  ███████╗
  ██╔════╝ ██║   ██║ ██╔════╝  ██║ ██╔╝ ██╔════╝  ██╔═══██╗ ██╔═══██╗ ██╔════╝
  █████╗   ██║   ██║ ██║       █████╔╝  ██║       ██║   ██║ ██║   ██║ █████╗
  ██╔══╝   ██║   ██║ ██║       ██╔═██╗  ██║       ██║   ██║ ██║   ██║ ██╔════╝
  ██║      ╚██████╔╝ ╚██████╗  ██║  ██╗ ╚██████╗  ╚██████╔╝ ╚██████╔╝ ███████╗
  ╚═╝       ╚═════╝   ╚═════╝  ╚═╝  ╚═╝  ╚═════╝   ╚═════╝   ╚═════╝  ╚══════╝
```

**就他妈写代码，别废话。**

原生中文、暴躁人格的终端 AI 编码工具。从需求到开发测试的完整流程一个命令搞定。

[快速开始](#快速开始) · [功能](#核心功能) · [命令](#命令列表) · [配置](#配置) · [自定义](#深度定制)

</div>

---

## 这是什么

fuckcode 是一个跑在终端里的 AI 编码助手——你对它说需求，它自己读文件、改代码、跑测试、查 bug。脾气不好但活儿干得漂亮。

和 Claude Code / opencode 对标，但：

- **原生中文**：system prompt、工具描述、界面、错误提示全中文
- **暴躁人格**：嘴上不饶人，但技术方案扎实
- **`/workflow` 四阶段**：理解→实现→验证→回顾，全自动闭环
- **`/goal` 目标驱动**：设个目标它持续干到达成
- **15 个工具**：Read / Write / Edit / Bash / Grep / Glob / Task / TodoWrite / WebSearch / WebFetch / Skill / LSP...
- **多 Provider**：Anthropic / OpenAI / MiniMax / DeepSeek / Ollama 等
- **MCP 客户端**：接外部工具生态（GitHub / 数据库 / 浏览器）
- **Skill 系统**：按需加载的领域知识包
- **记忆系统**：跨会话记住你的偏好

## 快速开始

### 方式一：编译二进制（推荐，不需要装 Bun）

```bash
git clone https://github.com/maken2012/fuck-code.git
cd fuck-code
bun install
bun run build                    # 编译成单文件二进制（64M）
./fuckcode                       # 直接跑，不需要 Bun
```

全局安装：

```bash
bun run install:binary           # 编译 + 拷到 /usr/local/bin/
fuckcode                         # 任意目录运行
fc                               # 简称也行
```

### 方式二：开发模式

```bash
git clone https://github.com/maken2012/fuck-code.git
cd fuck-code
bun install                      # 需要 Bun >= 1.2
bun run dev                      # 直跑 TS 源码
```

### 设置 API Key

```bash
# 方式一：配置文件（推荐）
mkdir -p ~/.fuckcode
cat > ~/.fuckcode/config.json << 'EOF'
{
  "model": "claude-sonnet-4-5-20250929",
  "apiKey": "sk-ant-你的key"
}
EOF

# 方式二：环境变量
export ANTHROPIC_API_KEY=sk-ant-你的key

# 方式三：CLI flag
bun run dev -- --api-key sk-ant-你的key
```

### 第三方 Provider（MiniMax / DeepSeek / Ollama 等）

```json
{
  "model": "MiniMax-M3",
  "apiBaseUrl": "https://api.minimaxi.com/anthropic",
  "provider": "anthropic",
  "apiKey": "sk-cp-你的key"
}
```

> `provider` 字段很重要：MiniMax 等用 Anthropic 兼容接口的服务要设 `"provider": "anthropic"`，否则会 404。

Ollama / vLLM 等本地模型：

```json
{
  "model": "llama3",
  "apiBaseUrl": "http://localhost:11434/v1",
  "apiKey": "dummy"
}
```

## 核心功能

### 四阶段工作流 `/workflow`

一个命令，自动从需求走到交付：

```
> /workflow 给用户列表加分页功能

─── 理解需求 ──────────────────
[READ] 找到 src/components/UserList.tsx
[PLAN] 分析现有实现 + 设计分页方案

─── 实现代码 ──────────────────
[EDIT] 修改 UserList.tsx 加分页逻辑
[WRITE] 创建 usePagination.ts hook

─── 验证测试 ──────────────────
[BASH] bun test
[ OK ] 全部通过

─── 回顾汇报 ──────────────────
改了 2 个文件，测试通过，无遗留问题。
```

### 目标驱动 `/goal`

设个目标，它持续干到达成（最多 10 轮）：

```
> /goal 所有测试通过并且 typecheck 0 错误
```

### 15 个内置工具

| 工具 | 说明 |
|------|------|
| `[READ]` | 读文件（行号格式） |
| `[WRITE]` | 写文件（整文件重写，需先读） |
| `[EDIT]` | 字符串替换（写前必读 + mtime 校验） |
| `[BASH]` | 执行命令（超时 + 后台 + 输出截断） |
| `[GREP]` | ripgrep 内容搜索 |
| `[GLOB]` | 文件匹配 |
| `[TASK]` | 子 agent（explore / general / fork 三模式） |
| `[TODO]` | 任务跟踪（pending / in_progress / completed） |
| `[WEB]` | 抓 URL 内容（SSRF 防护） |
| `[FIND]` | Web 搜索 |
| `[ASK]` | 向用户问选择题 |
| `[SKILL]` | 按需加载领域知识 |
| `[LSP]` | TypeScript 类型诊断 |
| `[TREE]` | 创建 git worktree 隔离改动 |
| `[BACK]` | 退出 worktree |

### 安全保障

- **Edit/Write 写前必读**：没读过的文件不让改（防盲改）
- **mtime 校验**：读完后文件被外部改过则拒绝编辑（防覆盖）
- **权限管线**：allow / ask / deny 三级 + 弹窗确认
- **SSRF 防护**：WebFetch 拒绝内网地址
- **文件 checkpoint**：每次 Edit/Write 前自动备份，`/rewind` 一键回滚

## 命令列表

输入 `/` 自动弹出命令提示（上下选中、Tab 确认）：

| 命令 | 说明 |
|------|------|
| `/workflow <需求>` | 四阶段工作流（理解 > 实现 > 验证 > 回顾） |
| `/goal <目标>` | 目标驱动：持续工作直到达成 |
| `/plan <需求>` | 只读分析，产出实施计划 |
| `/context` | 分析上下文 token 占用 |
| `/diff` | 查看本次会话改动 |
| `/rewind [N]` | 回滚文件到 checkpoint |
| `/model [名]` | 查看 / 切换模型 |
| `/skills [create]` | 查看 / 创建 skill |
| `/sessions` | 列出历史会话 |
| `/resume <N>` | 恢复历史会话 |
| `/cost` | token 用量 |
| `/less-perms` | 生成权限白名单 |
| `/init` | 生成 AGENTS.md |
| `/agents` | 显示 AGENTS.md |
| `/clear` | 清空上下文 |
| `/help` | 完整帮助 |
| `/exit` | 退出 |

**快捷键**：`上下` 历史 / `Tab` 补全 / `Esc` 清空 / `Ctrl+C` 中断或退出 / `Ctrl+L` 清屏

## 配置

配置文件三层覆盖（优先级：CLI flag > 项目 > 用户）：

- 用户级：`~/.fuckcode/config.json`
- 项目级：`.fuckcode/config.json`

完整字段：

```json
{
  "model": "claude-sonnet-4-5-20250929",
  "fallbackModels": ["claude-haiku-3-5"],
  "apiKey": "sk-ant-...",
  "apiBaseUrl": "https://api.anthropic.com",
  "provider": "anthropic",
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
| `model` | `claude-sonnet-4-5-20250929` | 模型 ID |
| `fallbackModels` | `[]` | 主模型 429 时按序切备用 |
| `apiKey` | — | API Key（也可用环境变量） |
| `apiBaseUrl` | — | 第三方兼容 API 地址 |
| `provider` | 自动判定 | `anthropic` / `openai` / `openai-compatible` |
| `permissions` | 空 | 权限规则 |
| `permissionMode` | `default` | `default` / `acceptEdits` / `plan` / `bypassPermissions` |
| `maxTokens` | `8192` | 单次最大 token |
| `contextWindow` | `200000` | 上下文窗口 |

## 深度定制

### AGENTS.md（项目级行为约定）

```
/init    # 生成模板
```

编辑 `AGENTS.md`，写明代码风格、常用命令、禁忌。agent 启动自动加载，向上查找多层级合并。

### Skill（按需加载的领域知识）

```
/skills create vue-debug    # 创建 skill
/skills                     # 查看已有
```

在 `.fuckcode/skills/<名字>/SKILL.md` 写领域知识。兼容 `.claude/skills/` 格式。

### 记忆系统（跨会话持久化）

agent 自动从对话中提取偏好和约定（"以后都用 bun"），存到 `.fuckcode/memory/`。下次对话自动注入。

### MCP 客户端（接外部工具）

```json
// .fuckcode/mcp.json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "remote": { "url": "https://example.com/mcp", "transport": "http" }
  }
}
```

支持 stdio / sse / http 三种 transport。

### Hook 系统

```json
// .fuckcode/hooks.json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Edit", "command": "echo '改文件' >> /tmp/fc.log" }]
  }
}
```

### 自定义斜杠命令

```markdown
<!-- .fuckcode/commands/commit.md -->
---
description: 帮我写 commit
---
帮我写 commit message。改动如下：
!git diff --stat
```

### 自定义工具

```typescript
// .fuckcode/tools/my-tool.ts
export default buildTool({
  name: 'MyTool',
  description: '我的自定义工具',
  // ...
})
```

### `--safe-mode`（排查问题）

```bash
fuckcode --safe-mode    # 禁用所有定制（AGENTS.md / memory / hooks / MCP / 自定义命令）
```

## 开发

```bash
bun install              # 装依赖
bun test                 # 跑测试（252 tests）
bun run typecheck        # 类型检查
bun run dev              # 开发模式
bun run build            # 编译二进制
```

### 技术栈

- **TypeScript + Bun** — 运行时 + 包管理
- **Effect.ts** — 服务层（中度使用）
- **Ink + React** — 终端 UI
- **Anthropic SDK + OpenAI SDK** — 多 provider
- **MCP SDK** — 外部工具生态

### 架构

```
TUI 层 (repl/, Ink/React)
  ↓
Agent 层 (agent/, async generator) ← queryLoop 核心循环
  ↓
LLM 层 (llm/, provider 路由)  +  工具层 (tools/, async)
  ↓
Service 层 (services/, Effect.ts)
```

## 路线图

- [x] M1-M6 MVP（骨架 + LLM + 工具 + 权限 + 会话 + 打磨）
- [x] v1.0 工作流层（`/workflow` 四阶段）
- [x] v1.1-v1.3 扩展工具 + 并发执行 + Hook
- [x] v1.4 MCP 客户端 + 多 provider
- [x] v1.5-v1.6 记忆系统 + checkpoint + 子 agent fork
- [x] v1.7-v1.12 LSP + 输入持久化 + Skill + 自动记忆 + fallbackModel + `/goal`
- [ ] 多平台二进制（Linux / Windows）
- [ ] 插件系统
- [ ] background agents

## 参考来源

- **[Claude Code](https://github.com/anthropics/claude-code)** — 工具接口、queryLoop、权限管线、写前必读
- **[opencode](https://github.com/sst/opencode)** — Effect.ts 架构、MCP 客户端、AGENTS.md

差异化：原生中文 + 暴躁人格 + `/workflow` 四阶段 + 自动记忆零成本。

## License

MIT
