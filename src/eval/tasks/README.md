# fuckcode eval 任务编写指南

## 快速开始

```bash
# 跑单个任务
bun run src/eval/cli.ts src/eval/tasks/01-add-function.task.json

# 跑整个目录
bun run src/eval/cli.ts --dir src/eval/tasks

# 录制模式（真实调用 LLM，保存响应用于回放）
bun run src/eval/cli.ts --dir src/eval/tasks --record

# 回放模式（零成本复现，不调 API）
bun run src/eval/cli.ts --dir src/eval/tasks --replay

# 并发 + 重试
bun run src/eval/cli.ts --dir src/eval/tasks -j 3 --retries 2

# 保留工作区（调试用）
bun run src/eval/cli.ts src/eval/tasks/01-add-function.task.json --no-cleanup
```

## 任务分类体系

任务按能力维度分目录组织（详见 `_categories.md`）：

| 目录 | 类型 | 测什么 | 判定方式 |
|------|------|--------|----------|
| `algorithm/` | 确定性 | 算法/逻辑 | 单元测试 exit 0 |
| `data-structure/` | 确定性 | 数据结构实现 | 单元测试 |
| `parsing/` | 确定性 | 解析/字符串 | 单元测试 |
| `bugfix/` | 确定性 | Bug 定位修复 | 回归测试 |
| `architecture/` | 开放式 | 架构/系统设计 | multi-rubric + LLM-judge |
| `requirements/` | 开放式 | 需求分析/业务设计 | multi-rubric + LLM-judge |

`tasks/` 根目录下的 `01-05` 是冒烟测试集（快速验证 harness 跑通）。

**跑特定维度**：`bun run eval --dir src/eval/tasks/algorithm`
**跑全部**：逐个目录跑，或把所有 `.task.json` 汇总到一个目录

> 开放式任务（architecture/requirements）是业界空白点——SWE-bench/Aider 全是"给需求写代码"，没人测架构设计能力。

## 任务文件结构

每个任务是 `.task.json` 文件，schema 如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 唯一 id |
| `name` | string | 任务名（报告里展示） |
| `description` | string | 描述 |
| `difficulty` | `easy`/`medium`/`hard` | 难度 |
| `workspace` | object | 工作区设置（见下） |
| `turns` | Turn[] | 对话轮次（1=单轮，多个=累积式） |
| `judge` | JudgeSpec | 判定方式 |
| `timeoutMs` | number? | 任务超时（默认 120000） |

### workspace：3 种隔离模式

```jsonc
// 1. scratch：空目录 + 手写文件（最快）
{
  "type": "scratch",
  "files": {
    "calc.ts": "export function add(a, b) { ... }",
    "calc.test.ts": "..."
  }
}

// 2. from-repo：git clone（适合真实仓库任务）
{
  "type": "from-repo",
  "repo": "https://github.com/user/repo.git",
  "commit": "abc123",    // 可选，默认 HEAD
  "depth": 1             // 可选，默认浅克隆
}

// 3. from-snapshot：复制本地目录
{
  "type": "from-snapshot",
  "snapshotDir": "/path/to/template"
}
```

### turns：对话轮次

```jsonc
[
  {
    "prompt": "请实现 add 函数",
    "expectTools": ["Edit", "Bash"]  // 软断言：期望调用的工具（仅记录）
  }
]
```

- 1 个 turn = 单轮任务
- 多个 turn = 累积引导式：同一个 session 内连续喂 prompt，模型在前一轮产出上继续

### judge：4 种判定方式

```jsonc
// 1. test：跑命令，exit 0 = pass（最可靠）
{ "type": "test", "command": "bun test", "timeoutMs": 30000 }

// 2. lint：类型检查，默认 npx tsc --noEmit
{ "type": "lint", "command": "npx tsc --noEmit" }

// 3. behavior：行为断言
{
  "type": "behavior",
  "assertions": [
    { "kind": "file-exists", "path": "greet.ts" },
    { "kind": "file-not-exists", "path": "temp.ts" },
    { "kind": "file-contains", "path": "greet.ts", "pattern": "你好" },
    { "kind": "file-not-contains", "path": "src.ts", "pattern": "TODO" },
    { "kind": "command-exits-zero", "command": "bun run greet.ts", "timeoutMs": 10000 }
  ]
}

// 4. llm-judge：用 LLM 按 rubric 打分（适合开放性任务）
{
  "type": "llm-judge",
  "rubric": "代码应：1.结构清晰 2.有错误处理 3.命名规范 4.有注释",
  "model": "claude-sonnet-4-5-20250929"  // 可选，默认用 driver 同款
}

// 4b. multi-rubric：多维度 rubric + LLM-judge（架构设计/需求分析用）
{
  "type": "multi-rubric",
  "passThreshold": 0.65,   // 加权总分超过此值算 pass
  "dimensions": [
    { "name": "可扩展性", "weight": 0.3, "criteria": "策略模式用得好不好" },
    { "name": "正确性", "weight": 0.25, "criteria": "逻辑是否正确" },
    { "name": "接口设计", "weight": 0.25, "criteria": "API 是否清晰" },
    { "name": "文档", "weight": 0.2, "criteria": "设计说明质量" }
  ]
}

// 5. composite：组合多个（requireAll=true 全过才算过）
{
  "type": "composite",
  "requireAll": true,
  "judges": [
    { "type": "test", "command": "bun test" },
    { "type": "behavior", "assertions": [...] }
  ]
}
```

## 判定优先级建议

1. **test**（单元测试 exit 0）—— 最可靠，优先用
2. **behavior**（文件存在/命令可执行）—— 没有测试套件时用
3. **lint**（类型检查）—— 重构类任务用
4. **multi-rubric**（多维度 LLM 打分）—— 架构设计/需求分析类开放任务，业界空白点
5. **llm-judge**（单一 rubric LLM 打分）—— 开放性任务兜底，有成本和不确定性

## 示例任务

### 冒烟测试集（根目录）

| 文件 | 形态 | 判定 |
|------|------|------|
| `01-add-function` | 单轮 | test（bun test） |
| `02-fix-bug` | 单轮 | test（bun test） |
| `03-refactor` | 单轮 | composite（lint + behavior） |
| `04-multi-turn-accumulate` | 4 轮累积 | composite（test + behavior） |
| `05-behavior-assert` | 单轮 | behavior（文件 + 命令） |

### 分类任务集（13 个）

| 维度 | 任务 | 语言 | 难度 |
|------|------|------|------|
| algorithm | 二分查找 | TS | easy |
| algorithm | 合并区间 | Python | medium |
| algorithm | 可配置 FizzBuzz | Go | easy |
| data-structure | 双向链表 | TS | medium |
| data-structure | 二叉搜索树 | Python | medium |
| parsing | CSV 解析器 | TS | medium |
| parsing | TOML 读取器 | Python | hard |
| bugfix | 分页 off-by-one | TS | easy |
| bugfix | 异步资源泄漏 | Python | medium |
| architecture | 缓存系统设计 | TS | hard |
| architecture | API 网关设计 | TS | hard |
| requirements | RESTful API 设计 | TS | medium |
| requirements | 功能拆解为任务 | TS | medium |

## 录制/回放机制

```bash
# 第一次：真实调用，保存 LLM 响应
bun run src/eval/cli.ts --dir src/eval/tasks --record

# 之后：零成本复现（不调 API，回放录制的响应）
bun run src/eval/cli.ts --dir src/eval/tasks --replay
```

录制文件保存在 `~/.fuckcode/eval-recordings/<task-id>.jsonl`，每行是一次 LLM 调用的完整事件序列。

用途：
- **CI 集成**：回放模式不花钱，可加入 CI
- **回归测试**：改了 driver/queryLoop 后用回放验证行为不变
- **结果复现**：录制的响应可复现评测结果

## 输出

- **终端表格**：实时进度 + 最终汇总
- **JSON 明细**：`~/.fuckcode/eval-results/<timestamp>.json`，含每轮完整数据
- **exit code**：有失败返回 1（CI 友好）
