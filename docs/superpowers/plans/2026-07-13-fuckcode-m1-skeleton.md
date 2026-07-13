# fuckcode M1 骨架实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭起 fuckcode 项目的可运行骨架——一个能用 `fuckcode` 命令启动、进入中文 Ink 交互界面（显示欢迎语和输入框、回车回显）的空 REPL，底层 bootstrap 一个 Effect runtime 并挂上最小 Config/Logger 服务。

**Architecture:** TypeScript + Bun 单包工程。入口 `bin/fuckcode.js`（Bun shebang）转发到 `src/cli.tsx`（Commander 解析参数），cli 启动时构建 Effect runtime（Context.Tag + Layer + Runtime），再把控制权交给 Ink 渲染 `src/repl/App.tsx`。Service 层（Config/Logger）用 Effect 实现、对外暴露 async API；REPL 层完全用 React/async，不感知 Effect。

**Tech Stack:**
- 运行时：Bun ≥ 1.2（**本机未安装，Task 1 会装**）
- 语言：TypeScript（ESM, `jsx: 'react-jsx'`）
- 效应系统：`effect@3.21.4`
- TUI：`ink@7.1.0` + `react@18.3.1`（**⚠️ 不要用 React 19**——与 `@types/react@19` 的 JSX 全局类型有兼容坑，见 [DefinitelyTyped #52321](https://github.com/DefinitelyTyped/DefinitelyTyped/issues/52321)）
- CLI：`@commander-js/extra-typings@15.0.0`
- 配置校验：`zod@3`
- 测试：`bun test`（Bun 内置，不引入 vitest）

**前置依赖（本机现状）：**
- ✅ Node v22.22.3
- ✅ ripgrep 13.0.0（位于 ZCode.app，后续 M3 Grep 工具会用）
- ❌ **Bun 未安装** — Task 1 安装

**工作目录：** `/Users/shun/Desktop/fuck-code`（已是 git 仓库，当前分支 `chore/fuckcode-design-doc`）

---

## 文件结构（本计划产出）

```
fuck-code/
├── package.json                 # Task 2 — 依赖 + bin + scripts
├── tsconfig.json                # Task 3 — TS 配置（jsx: react-jsx, ESM）
├── bunfig.toml                  # Task 3 — Bun 配置
├── .gitignore                   # Task 2 — 忽略 node_modules/dist
├── bin/
│   └── fuckcode.js              # Task 4 — shebang 入口，转发到 src/cli.tsx
├── src/
│   ├── cli.tsx                  # Task 5 — Commander 入口，bootstrap runtime + 启动 REPL
│   ├── services/
│   │   ├── runtime.ts           # Task 6 — Effect Runtime 组装（程序级单例）
│   │   ├── Config.ts            # Task 7 — Config Service（读 ~/.fuckcode/config.json，Zod 校验）
│   │   ├── Logger.ts            # Task 8 — Logger Service（结构化控制台日志）
│   │   └── Paths.ts             # Task 7 — ~/.fuckcode 路径解析辅助
│   ├── repl/
│   │   ├── App.tsx              # Task 9 — Ink 根组件（render 入口）
│   │   └── Repl.tsx             # Task 10 — REPL 状态机（欢迎语 + 输入框 + 回显）
│   └── version.ts               # Task 5 — 版本号常量
└── tests/
    ├── services/
    │   ├── Config.test.ts       # Task 7 — Config 加载/合并/默认值
    │   └── Paths.test.ts        # Task 7 — 路径解析
    └── repl/
        └── Repl.test.ts         # Task 10 — REPL 渲染（ink testing）
```

**职责划分（每个文件一件事）：**
- `bin/fuckcode.js`：纯入口转发，零业务
- `cli.tsx`：参数解析 + 决定走 REPL 还是 print-and-exit（M1 只有 REPL）
- `services/runtime.ts`：把所有 Layer 合成一个 Runtime，导出 `runtime` 单例和便捷的 `runEffect` 函数
- `services/Config.ts` / `Logger.ts`：各是一个 Service，互不依赖（Logger 不依赖 Config）
- `services/Paths.ts`：纯函数，解析 `~/.fuckcode` 下各种路径
- `repl/App.tsx`：调 `render()`，挂载 `<Repl/>`
- `repl/Repl.tsx`：交互逻辑（M1 极简：欢迎语 + 输入框 + 回显历史）

---

## Task 1: 安装 Bun 运行时

**Files:** 无（仅环境）

- [ ] **Step 1: 确认 bun 缺失**

Run: `bun --version`
Expected: `bun: command not found`（或类似）

- [ ] **Step 2: 用官方脚本安装 Bun**

Run: `curl -fsSL https://bun.sh/install | bash`
Expected: 输出 `Welcome to Bun!` 并提示已加入 PATH。脚本会把 bun 装到 `~/.bun/bin/bun`。

- [ ] **Step 3: 让当前 shell 识别 bun**

Run: `source ~/.zshrc 2>/dev/null; export PATH="$HOME/.bun/bin:$PATH"; bun --version`
Expected: 打印版本号（≥ 1.2.x）。

- [ ] **Step 4: 验证 bun 可执行 TS**

Run:
```bash
export PATH="$HOME/.bun/bin:$PATH"
echo 'const x: number = 42; console.log(x)' > /tmp/probe.ts
bun /tmp/probe.ts
```
Expected: 打印 `42`，证明 Bun 能直接跑 TS。

- [ ] **Step 5: 记录安装结果，无需 commit（环境改动）**

在对话中向用户报告："Bun 已安装到 ~/.bun/bin/bun，版本 X.Y.Z。⚠️ 后续所有 `bun` 命令需要在 PATH 含 `~/.bun/bin` 的 shell 中执行；若你的交互 shell 未自动加载，请先 `export PATH="$HOME/.bun/bin:$PATH"`。"

---

## Task 2: 初始化 package.json + .gitignore

**Files:**
- Create: `package.json`
- Create: `.gitignore`

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "fuckcode",
  "version": "0.1.0",
  "description": "原生中文交互的终端 AI 编码工具",
  "type": "module",
  "private": true,
  "bin": {
    "fuckcode": "./bin/fuckcode.js",
    "fc": "./bin/fuckcode.js"
  },
  "scripts": {
    "dev": "bun run src/cli.tsx",
    "start": "bun run bin/fuckcode.js",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "0.111.0",
    "@commander-js/extra-typings": "15.0.0",
    "effect": "3.21.4",
    "ink": "7.1.0",
    "react": "18.3.1",
    "zod": "3.24.0"
  },
  "devDependencies": {
    "@types/bun": "1.2.0",
    "@types/react": "18.3.0",
    "typescript": "5.7.0"
  },
  "engines": {
    "bun": ">=1.2.0"
  }
}
```

说明：
- `bin` 注册 `fuckcode` 和 `fc` 两个命令指向同一入口
- `@anthropic-ai/sdk` M1 不用，但提前装好，M2 直接 import
- `type: module` + Bun 天生支持 ESM 和 `.tsx`
- **React 用 18.3.1 而非 19**——Ink 7 要求 React ≥ 18；React 19 的 `@types/react@19` 与 JSX 全局类型有兼容坑（DefinitelyTyped #52321），M1 规避

- [ ] **Step 2: 写 .gitignore**

```gitignore
node_modules/
dist/
*.log
.DS_Store
.fuckcode/
```

- [ ] **Step 3: 安装依赖**

Run: `bun install`
Expected: 生成 `bun.lock` + `node_modules/`，无报错。若网络慢可加 `--no-progress`。

- [ ] **Step 4: 验证依赖可 import**

Run:
```bash
bun -e "import('effect').then(e => console.log('effect', e.Context ? 'ok' : 'missing'))"
bun -e "import('ink').then(e => console.log('ink', typeof e.render))"
bun -e "import('@commander-js/extra-typings').then(e => console.log('commander', typeof e.Command))"
```
Expected: 三行分别打印 `effect ok`、`ink function`、`commander function`。

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock .gitignore
git commit -m "chore: 初始化 package.json 与依赖

- 注册 fuckcode/fc bin 入口
- 依赖：effect 3.21 / ink 7.1 / react 19 / commander / zod / anthropic sdk
- ESM (type: module)，Bun 运行时"
```

---

## Task 3: 配置 TypeScript + Bun（tsconfig.json / bunfig.toml）

**Files:**
- Create: `tsconfig.json`
- Create: `bunfig.toml`

- [ ] **Step 1: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "types": ["bun"],
    "paths": {
      "@/*": ["./src/*"]
    },
    "baseUrl": "."
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules"]
}
```

说明：
- `jsx: 'react-jsx'` — Ink 7 + React 19 用新的 JSX 转换，无需 `import React`
- `moduleResolution: 'bundler'` — 匹配 Bun 的解析行为
- `verbatimModuleSyntax: true` — 强制 type-only import 用 `import type`，避免 Bun 运行时报错
- `noUncheckedIndexedAccess: true` — 严格模式，数组/对象索引返回 `T | undefined`
- `paths` 配置 `@/` 指向 `src/`（后续 import 用 `@/services/Config`）

- [ ] **Step 2: 写 bunfig.toml**

```toml
[install]
# 使用国内镜像可选，默认不设；如需可加 registry = "https://registry.npmmirror.com"

[test]
# bun test 配置，M1 暂无特殊项
```

- [ ] **Step 3: 验证类型检查通过（虽然 src 还空）**

Run: `bun run typecheck`
Expected: `tsc --noEmit` 无输出（0 错误）或仅提示"无输入文件"。如果报 `Cannot find type definition file for 'bun'`，确认 `@types/bun` 已装（Task 2 Step 4 验证过）。

- [ ] **Step 4: Commit**

```bash
git add tsconfig.json bunfig.toml
git commit -m "chore: 配置 TypeScript（jsx: react-jsx, ESM, strict）与 bunfig"
```

---

## Task 4: bin/fuckcode.js 入口

**Files:**
- Create: `bin/fuckcode.js`

- [ ] **Step 1: 写 bin/fuckcode.js**

```javascript
#!/usr/bin/env bun
// bin/fuckcode.js — fuckcode CLI 入口
// 这是一个薄封装：转发到真正的 TS 入口 src/cli.tsx
// 用 Bun shebang，因为整个项目依赖 Bun 运行时（package.json engines.bun）

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cliEntry = resolve(__dirname, '..', 'src', 'cli.tsx')

// 动态 import 让 Bun 即时编译 .tsx
await import(cliEntry)
```

说明：
- `#!/usr/bin/env bun` — 用 Bun 解释（M1 简化方案，假设用户已装 Bun；未来要兼容纯 Node 可加 fallback shim，参考 opencode 的 `packages/opencode/bin/opencode`）
- 用 `await import` 而非 `require`，因为是 ESM
- 路径基于 `import.meta.url`，不依赖 cwd

- [ ] **Step 2: 给入口加可执行权限**

Run: `chmod +x bin/fuckcode.js`
Expected: 无输出。`ls -la bin/fuckcode.js` 应显示 `-rwxr-xr-x`。

- [ ] **Step 3: 验证入口能被 bun 直接执行（src/cli.tsx 还没写，预期会报找不到模块）**

Run: `bun run bin/fuckcode.js`
Expected: 报 `Cannot find module './src/cli.tsx'` 或类似——**这是预期的**，证明入口本身语法正确、转发逻辑生效。Task 5 写完 cli.tsx 后就不会报了。

- [ ] **Step 4: Commit**

```bash
git add bin/fuckcode.js
git commit -m "feat(bin): 添加 fuckcode CLI 入口（Bun shebang，转发到 src/cli.tsx）"
```

---

## Task 5: src/version.ts + src/cli.tsx（Commander 入口）

**Files:**
- Create: `src/version.ts`
- Create: `src/cli.tsx`

- [ ] **Step 1: 写 src/version.ts**

```typescript
// src/version.ts
// 版本号集中管理，cli.tsx 的 --version 和 system prompt 都会用到
export const VERSION = '0.1.0'
export const NAME = 'fuckcode'
```

- [ ] **Step 2: 写 src/cli.tsx**

```tsx
// src/cli.tsx
// CLI 参数解析入口。M1 只支持交互式 REPL；print-and-exit 模式留 M2。
import { Command } from '@commander-js/extra-typings'
import { VERSION, NAME } from '@/version.js'
import { startRepl } from '@/repl/App.js'

const program = new Command()
  .name(NAME)
  .description('原生中文交互的终端 AI 编码工具')
  .version(VERSION)
  .argument('[prompt]', '可选的一次性提示（M1 暂不支持，留 M2）')
  .option('-v, --verbose', '启用详细日志输出', false)
  .action(async (prompt, opts) => {
    // M1: 无论参数如何，都进 REPL
    // M2 会在这里分流：有 prompt → 一次性模式；无 prompt → REPL
    if (prompt) {
      console.error(`[M1] 一次性模式将在 M2 支持，本次忽略提示，进入交互模式。`)
    }
    await startRepl({ verbose: opts.verbose })
  })

// 仅当此文件是主入口时解析参数（避免被 import 时副作用执行）
const isMain = typeof Bun !== 'undefined' && process.argv[1]?.endsWith('cli.tsx')
if (isMain) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error(`\n${NAME} 启动失败:`, err)
    process.exit(1)
  })
}

export { program }
```

说明：
- `@commander-js/extra-typings` 提供完全类型化的 Command（比普通 commander 好）
- `.argument('[prompt]')` 用方括号 = 可选位置参数
- `process.argv[1]?.endsWith('cli.tsx')` 判断是否主入口，避免测试时 import 触发 parse
- `startRepl` 来自下一个 Task 的 App.tsx，本步先写出来，下一步实现

- [ ] **Step 3: 验证 cli.tsx 语法正确（startRepl 还没实现，预期会报找不到模块）**

Run: `bun run src/cli.tsx --help`
Expected: 报 `Cannot find module '@/repl/App.js'` 或类似——**预期**，证明 commander 解析本身没问题（如果 commander 报错会是别的错）。Task 9 实现 App 后就好了。

- [ ] **Step 4: Commit**

```bash
git add src/version.ts src/cli.tsx
git commit -m "feat(cli): Commander 入口，解析参数并启动 REPL

- @commander-js/extra-typings 类型化 CLI
- --version / --verbose / [prompt] 参数
- M1 阶段所有输入都进 REPL"
```

---

## Task 6: src/services/runtime.ts（Effect Runtime 组装）

**Files:**
- Create: `src/services/runtime.ts`

这是中度 Effect 架构的"装配中心"。程序启动时构建一次 Runtime，全局共享。

- [ ] **Step 1: 写 src/services/runtime.ts**

```typescript
// src/services/runtime.ts
// 程序级 Effect Runtime 单例。
// 设计原则：Service 对外暴露 async API（内部 Effect.runPromise），
// 上层（agent loop、TUI）完全不感知 Effect。
import { Effect, Runtime, Layer } from 'effect'
import { Config, ConfigLive } from '@/services/Config.js'
import { Logger, LoggerLive } from '@/services/Logger.js'

// 构建主 Layer（合并所有 Service 的实现）
export function buildMainLive(opts?: { verbose?: boolean }) {
  return Layer.mergeAll(
    ConfigLive,
    LoggerLive({ verbose: opts?.verbose ?? false }),
  )
}

// 用 Runtime.defaultRuntime.pipe(Runtime.addLayer(live)) 构建 runtime
// 这是 effect@3.21.4 最稳的写法（比 Runtime.make 返回类型更确定）
export function buildRuntime(opts?: {
  verbose?: boolean
}): Runtime.Runtime<Config | Logger> {
  return Runtime.defaultRuntime.pipe(
    Runtime.addLayer(buildMainLive(opts)),
  ) as Runtime.Runtime<Config | Logger>
}

// 全局 runtime 单例（启动期求值一次）
let _runtime: Runtime.Runtime<Config | Logger> | null = null
export function getRuntime(opts?: {
  verbose?: boolean
}): Runtime.Runtime<Config | Logger> {
  if (!_runtime) {
    _runtime = buildRuntime(opts)
  }
  return _runtime
}

// 便捷工具：在 Effect 上下文外运行一个 Effect（用全局 runtime）
export function runEffect<A, E>(
  effect: Effect.Effect<A, E, Config | Logger>,
  opts?: { verbose?: boolean },
): Promise<A> {
  return Runtime.runPromise(getRuntime(opts))(effect)
}

// 对外"假装不是 Effect"的 service 获取函数
export async function getConfig(): Promise<{
  value: import('@/services/Config.js').ConfigValue
}> {
  return runEffect(
    Effect.map(Config, (c) => c as { value: import('@/services/Config.js').ConfigValue }),
  )
}

export async function getLogger(): Promise<
  import('@/services/Logger.js').LoggerService
> {
  return runEffect(
    Effect.map(Logger, (l) => l as import('@/services/Logger.js').LoggerService),
  )
}
```

说明：
- `Runtime.defaultRuntime.pipe(Runtime.addLayer(live))` —— effect@3.21.4 最稳的 runtime 构建方式，避免 `Runtime.make(live)` 的返回类型不确定性（它在不同版本可能返回 `Runtime` 或 `Effect<Runtime>`）
- `Runtime.runPromise(rt)(effect)` —— 用指定 runtime 跑 Effect
- Service 获取函数返回 Promise，上层用 async/await，完全不感知 Effect

- [ ] **Step 2: 验证 runtime 模块语法（依赖的 Config/Logger 还没写，预期报找不到）**

Run: `bun run src/services/runtime.ts`
Expected: 报 `Cannot find module '@/services/Config.js'`——**预期**。

- [ ] **Step 3: Commit（先提交，Task 7-8 实现依赖后会通过）**

```bash
git add src/services/runtime.ts
git commit -m "feat(services): Effect Runtime 装配中心

- MainLive 合并所有 Service Layer
- runtime 全局单例 + runEffect 便捷函数
- Service 对外暴露 async API，上层不感知 Effect"
```

---

## Task 7: src/services/Paths.ts + src/services/Config.ts（含测试）

**Files:**
- Create: `src/services/Paths.ts`
- Create: `src/services/Config.ts`
- Test: `tests/services/Paths.test.ts`
- Test: `tests/services/Config.test.ts`

### 7a. Paths.ts

- [ ] **Step 1: 写测试 tests/services/Paths.test.ts（TDD: 先红）**

```typescript
// tests/services/Paths.test.ts
import { test, expect } from 'bun:test'
import { fuckcodeDir, configPath, projectsDir, projectHash } from '@/services/Paths.js'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

test('fuckcodeDir 返回 ~/.fuckcode', () => {
  expect(fuckcodeDir()).toBe(resolve(homedir(), '.fuckcode'))
})

test('configPath 返回 ~/.fuckcode/config.json', () => {
  expect(configPath()).toBe(resolve(homedir(), '.fuckcode', 'config.json'))
})

test('projectsDir 返回 ~/.fuckcode/projects', () => {
  expect(projectsDir()).toBe(resolve(homedir(), '.fuckcode', 'projects'))
})

test('projectHash 对相同路径稳定，对不同路径不同', () => {
  const a = projectHash('/Users/shun/projA')
  const b = projectHash('/Users/shun/projA')
  const c = projectHash('/Users/shun/projB')
  expect(a).toBe(b)
  expect(a).not.toBe(c)
  expect(a).toMatch(/^[a-f0-9]{12,}$/)  // hex hash
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/services/Paths.test.ts`
Expected: FAIL — `Cannot find module '@/services/Paths.js'`

- [ ] **Step 3: 写实现 src/services/Paths.ts**

```typescript
// src/services/Paths.ts
// ~/.fuckcode 下的路径解析辅助。纯函数，无副作用。
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

export function fuckcodeDir(): string {
  return resolve(homedir(), '.fuckcode')
}

export function configPath(): string {
  return resolve(fuckcodeDir(), 'config.json')
}

export function projectsDir(): string {
  return resolve(fuckcodeDir(), 'projects')
}

// 给 cwd 生成稳定 hash，用于隔离不同项目的会话存储
export function projectHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16)
}

// 某个项目的会话存储目录
export function projectSessionDir(cwd: string): string {
  return resolve(projectsDir(), projectHash(cwd))
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/services/Paths.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/Paths.ts tests/services/Paths.test.ts
git commit -m "feat(services): Paths 路径解析（~/.fuckcode 布局）"
```

### 7b. Config.ts（含 Zod schema）

- [ ] **Step 6: 写测试 tests/services/Config.test.ts**

```typescript
// tests/services/Config.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { loadConfig } from '@/services/Config.js'

// 测试用临时目录覆盖 HOME，避免污染真实 ~/.fuckcode
const tmpHome = resolve(process.env.TMPDIR || '/tmp', 'fc-test-home-' + process.pid)

beforeEach(async () => {
  await mkdir(resolve(tmpHome, '.fuckcode'), { recursive: true })
  process.env.HOME = tmpHome
})
afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true })
})

test('无配置文件时返回默认值', async () => {
  const cfg = await loadConfig()
  expect(cfg.model).toBe('claude-sonnet-4-5-20250929')
  expect(cfg.permissions.allow).toEqual([])
  expect(cfg.permissions.deny).toEqual([])
  expect(cfg.permissionMode).toBe('default')
  expect(cfg.contextWindow).toBe(200000)
})

test('读取用户级配置覆盖默认值', async () => {
  await writeFile(
    resolve(tmpHome, '.fuckcode', 'config.json'),
    JSON.stringify({ model: 'claude-opus-4-1', maxTokens: 4096 }),
  )
  const cfg = await loadConfig()
  expect(cfg.model).toBe('claude-opus-4-1')
  expect(cfg.maxTokens).toBe(4096)
  expect(cfg.permissionMode).toBe('default')  // 未设置的字段保留默认
})

test('配置 schema 拒绝非法 permissionMode', async () => {
  await writeFile(
    resolve(tmpHome, '.fuckcode', 'config.json'),
    JSON.stringify({ permissionMode: 'INVALID' }),
  )
  await expect(loadConfig()).rejects.toThrow()
})

test('project 级配置覆盖 user 级', async () => {
  await writeFile(
    resolve(tmpHome, '.fuckcode', 'config.json'),
    JSON.stringify({ model: 'user-level', maxTokens: 1000 }),
  )
  // 模拟项目级配置
  const projectConfigPath = resolve(process.cwd(), '.fuckcode', 'config.json')
  await mkdir(resolve(process.cwd(), '.fuckcode'), { recursive: true })
  await writeFile(projectConfigPath, JSON.stringify({ maxTokens: 9999 }))
  try {
    const cfg = await loadConfig({ cwd: process.cwd() })
    expect(cfg.model).toBe('user-level')        // 来自 user 级
    expect(cfg.maxTokens).toBe(9999)            // 来自 project 级（覆盖）
  } finally {
    await rm(resolve(process.cwd(), '.fuckcode'), { recursive: true, force: true })
  }
})
```

- [ ] **Step 7: 运行测试确认失败**

Run: `bun test tests/services/Config.test.ts`
Expected: FAIL — `Cannot find module '@/services/Config.js'`

- [ ] **Step 8: 写实现 src/services/Config.ts**

```typescript
// src/services/Config.ts
// Config Service：读 ~/.fuckcode/config.json + 项目级 .fuckcode/config.json，Zod 校验，深合并。
// 设计：对外暴露 loadConfig() async 函数 + Config Effect Service（runtime 用）。
import { Context, Effect, Layer } from 'effect'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { exists } from 'node:fs/promises'
import { resolve } from 'node:path'
import { configPath, fuckcodeDir } from '@/services/Paths.js'

// === Zod Schema（spec 5.4 节） ===
export const ConfigSchema = z.object({
  model: z.string().default('claude-sonnet-4-5-20250929'),
  apiKey: z.string().optional(),
  permissions: z
    .object({
      allow: z.array(z.string()).default([]),
      ask: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .default({}),
  permissionMode: z
    .enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
    .default('default'),
  maxTokens: z.number().int().positive().default(8192),
  contextWindow: z.number().int().positive().default(200000),
})
export type ConfigValue = z.infer<typeof ConfigSchema>

// === Service 定义（Effect Context.Tag 模式） ===
export class Config extends Context.Tag('Config')<Config, { readonly value: ConfigValue }>() {}

// === 加载逻辑 ===
async function readConfigFile(path: string): Promise<Partial<ConfigValue>> {
  if (!(await exists(path))) return {}
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as Partial<ConfigValue>
  } catch {
    return {}  // 解析失败按空处理，让 schema 用默认值（避免单个坏文件阻塞启动）
  }
}

// 深合并：project 覆盖 user，user 覆盖默认
function deepMerge(
  base: ConfigValue,
  ...overrides: Partial<ConfigValue>[]
): ConfigValue {
  const merged = overrides.reduce(
    (acc, ov) => ({
      ...acc,
      ...ov,
      permissions: {
        allow: ov.permissions?.allow ?? acc.permissions.allow,
        ask: ov.permissions?.ask ?? acc.permissions.ask,
        deny: ov.permissions?.deny ?? acc.permissions.deny,
      },
    }),
    base,
  )
  return ConfigSchema.parse(merged)
}

export async function loadConfig(opts?: { cwd?: string }): Promise<ConfigValue> {
  const userRaw = await readConfigFile(configPath())
  const cwd = opts?.cwd ?? process.cwd()
  const projectRaw = await readConfigFile(resolve(cwd, '.fuckcode', 'config.json'))
  // 合并顺序：默认 < user < project
  const defaults = ConfigSchema.parse({})
  return deepMerge(defaults, userRaw, projectRaw)
}

// === Effect Layer（runtime.ts 用） ===
export const ConfigLive = Layer.effect(
  Config,
  Effect.gen(function* () {
    const value = yield* Effect.tryPromise({
      try: () => loadConfig(),
      catch: (e: unknown) => new Error(`加载配置失败: ${String(e)}`),
    })
    return Config.of({ value })
  }),
)

// 兼容：避免 unused 警告
void fuckcodeDir
```

说明：
- `Context.Tag('Config')<Config, { value }>()` 是 Effect 3.x 的 Service 定义写法
- `ConfigLive` 是 Layer，runtime.ts 会把它合成进 MainLive
- `loadConfig` 是对外 async API，REPL/cli 直接调用即可（不必走 Effect）
- `exists` 来自 `node:fs/promises`（Node 22+ 支持）

- [ ] **Step 9: 运行测试确认通过**

Run: `bun test tests/services/Config.test.ts`
Expected: 4 tests PASS

- [ ] **Step 10: Commit**

```bash
git add src/services/Config.ts tests/services/Config.test.ts
git commit -m "feat(services): Config Service（Zod 校验 + user/project 两层合并）

- ConfigSchema 定义全部配置项与默认值
- loadConfig() 深合并 user < project
- Context.Tag + Layer.effect 暴露 Effect Service"
```

---

## Task 8: src/services/Logger.ts

**Files:**
- Create: `src/services/Logger.ts`

- [ ] **Step 1: 写 src/services/Logger.ts**

```typescript
// src/services/Logger.ts
// Logger Service：结构化控制台日志。
// M1 极简：把日志写到 stderr（不污染 Ink 的 stdout 渲染）。
// 未来可扩展为 Effect Logger service / 文件落盘 / OpenTelemetry。
import { Context, Effect, Layer } from 'effect'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LoggerService {
  readonly debug: (msg: string, meta?: Record<string, unknown>) => void
  readonly info: (msg: string, meta?: Record<string, unknown>) => void
  readonly warn: (msg: string, meta?: Record<string, unknown>) => void
  readonly error: (msg: string, meta?: Record<string, unknown>) => void
}

export class Logger extends Context.Tag('Logger')<Logger, LoggerService>() {}

function makeConsoleLogger(verbose: boolean): LoggerService {
  const write = (level: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (level === 'debug' && !verbose) return
    const ts = new Date().toISOString()
    const metaStr = meta && Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : ''
    // 写 stderr，避免干扰 Ink 的 stdout
    process.stderr.write(`[${ts}] [${level.toUpperCase()}] ${msg}${metaStr}\n`)
  }
  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
  }
}

export const LoggerLive = (opts?: { verbose?: boolean }) =>
  Layer.succeed(Logger, Logger.of(makeConsoleLogger(opts?.verbose ?? false)))
```

说明：
- **写 stderr** 是关键——Ink 用 stdout 做渲染，日志走 stderr 才不会破坏界面
- `LoggerLive` 是工厂函数，接受 verbose 参数（cli.tsx 的 --verbose 透传到 runtime.ts 的 buildMainLive）
- 这里与 Task 6 的 runtime.ts 配套：runtime.ts 的 `buildMainLive` 已经写成 `LoggerLive({ verbose })`，Task 8 实现完即配套生效

- [ ] **Step 2: 写一个最小冒烟测试 tests/services/Logger.test.ts**

```typescript
// tests/services/Logger.test.ts
import { test, expect } from 'bun:test'
import { Effect, Layer } from 'effect'
import { Logger, LoggerLive } from '@/services/Logger.js'

test('Logger 写入 stderr 不抛错', async () => {
  const program = Effect.gen(function* () {
    const logger = yield* Logger
    logger.info('hello', { k: 'v' })
    logger.debug('hidden')  // 非 verbose 模式不输出
  })
  await Effect.runPromise(program.pipe(Effect.provide(LoggerLive({ verbose: false }))))
  // 不报错即通过（stderr 输出可在测试输出里肉眼验证）
  expect(true).toBe(true)
})

test('verbose 模式 debug 也输出', async () => {
  const program = Effect.gen(function* () {
    const logger = yield* Logger
    logger.debug('visible-now')
  })
  await Effect.runPromise(program.pipe(Effect.provide(LoggerLive({ verbose: true }))))
  expect(true).toBe(true)
})
```

- [ ] **Step 3: 运行测试确认通过**

Run: `bun test tests/services/Logger.test.ts`
Expected: 2 tests PASS（stderr 里能看到 `[INFO] hello {"k":"v"}` 和 `[DEBUG] visible-now`）

- [ ] **Step 4: 验证 runtime.ts 与 Logger 配套正常**

Task 6 的 runtime.ts 已经写成 `buildMainLive(opts)` 调用 `LoggerLive({ verbose })` 的形式，Task 8 实现 LoggerLive 后即自动配套。验证一下整体类型：

Run: `bun run typecheck`
Expected: 0 错误（Logger/Config/runtime 三者类型闭合）。如果 `Layer.succeed(Logger, Logger.of(...))` 类型报错，确认 `Logger.of` 是 Effect 3.x 的 Service 构造器（用于把普通对象包装成 Service 实例）。

- [ ] **Step 5: Commit**

```bash
git add src/services/Logger.ts src/services/runtime.ts tests/services/Logger.test.ts
git commit -m "feat(services): Logger Service（stderr 结构化日志 + verbose 控制）

- write 到 stderr 避免干扰 Ink 渲染
- LoggerLive 改为工厂函数接受 verbose
- runtime.ts 改为 buildMainLive + getRuntime 模式"
```

---

## Task 9: src/repl/App.tsx（Ink render 入口）

**Files:**
- Create: `src/repl/App.tsx`

- [ ] **Step 1: 写 src/repl/App.tsx**

```tsx
// src/repl/App.tsx
// Ink render 入口。startRepl 是 cli.tsx 调用的对外函数。
import { render } from 'ink'
import React from 'react'
import { Repl } from '@/repl/Repl.js'
import { getRuntime, getConfig } from '@/services/runtime.js'

export interface StartReplOpts {
  verbose?: boolean
}

export async function startRepl(opts: StartReplOpts = {}): Promise<void> {
  // 启动期初始化 runtime（也触发 Config/Logger 的构建）
  getRuntime(opts)
  // 读一次 config 用于显示（如 model 名）
  const config = await getConfig().catch(() => null)

  const instance = render(
    <Repl
      version={config ? undefined : '0.1.0'}
      modelName={config?.value.model}
    />,
    {
      exitOnCtrlC: false,  // 我们自己处理 Ctrl+C（M4 配合 abort）
    },
  )

  // 等待 Ink 实例结束（用户 /exit 时 Repl 调用 unmount）
  await instance.wait()
}
```

说明：
- `import React from 'react'` — 虽然 jsx: react-jsx 下不需要 React 在作用域，但 ink 内部某些类型推导需要，保险起见 import
- `exitOnCtrlC: false` — Ctrl+C 由 Repl 自己处理（M1 可以让 Ctrl+C 触发退出，但走我们自己的逻辑方便 M4 扩展）
- `instance.wait()` 返回 Promise，在 `unmount()` 后 resolve

- [ ] **Step 2: 验证 App.tsx 类型（Repl 还没实现，预期报找不到）**

Run: `bun run typecheck 2>&1 | head -20`
Expected: 报 `Cannot find module '@/repl/Repl.js'`——**预期**，Task 10 实现后消失。

- [ ] **Step 3: Commit**

```bash
git add src/repl/App.tsx
git commit -m "feat(repl): Ink render 入口 startRepl

- 启动期构建 runtime 并预读 config
- exitOnCtrlC: false，Ctrl+C 走自定义逻辑"
```

---

## Task 10: src/repl/Repl.tsx（M1 空 REPL + 测试）

**Files:**
- Create: `src/repl/Repl.tsx`
- Test: `tests/repl/Repl.test.tsx`

M1 REPL 行为：显示欢迎语（含版本、模型名、快捷键提示）+ 输入框 + 回车后把输入作为消息追加到历史并清空输入框（**不调用 LLM**，纯回显，M2 接 queryLoop）。

- [ ] **Step 1: 写测试 tests/repl/Repl.test.tsx**

```tsx
// tests/repl/Repl.test.tsx
import { test, expect } from 'bun:test'
import React from 'react'
import { render } from 'ink'
import { Repl } from '@/repl/Repl.js'

test('Repl 渲染欢迎语和输入框', () => {
  const { lastFrame, unmount } = render(
    <Repl version="0.1.0-test" modelName="claude-sonnet-4-5" />,
  )
  const frame = lastFrame() ?? ''
  expect(frame).toContain('fuckcode')
  expect(frame).toContain('0.1.0-test')
  expect(frame).toContain('claude-sonnet-4-5')
  expect(frame).toMatch(/输入|>|(❯)/)  // 输入框提示符
  unmount()
})

test('Repl 显示快捷键提示', () => {
  const { lastFrame, unmount } = render(
    <Repl version="0.1.0" modelName="m" />,
  )
  const frame = lastFrame() ?? ''
  expect(frame).toContain('Ctrl+C')  // 提示快捷键
  unmount()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/repl/Repl.test.tsx`
Expected: FAIL — `Cannot find module '@/repl/Repl.js'`

- [ ] **Step 3: 写实现 src/repl/Repl.tsx**

```tsx
// src/repl/Repl.tsx
// M1 极简 REPL：欢迎语 + 输入框 + 回显历史。
// M2 会把 onSubmit 接到 queryLoop。
import React, { useState } from 'react'
import { Box, Text, useInput, useApp, Newline } from 'ink'

export interface ReplProps {
  version?: string
  modelName?: string
}

interface DisplayMessage {
  role: 'user' | 'assistant'
  text: string
}

export function Repl({ version = '0.1.0', modelName }: ReplProps) {
  const { exit } = useApp()
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<DisplayMessage[]>([])

  useInput((inputChar, key) => {
    // Ctrl+C / Ctrl+D 退出（M1 简化：直接退出；M4 会改为中断当前轮次）
    if (key.ctrl && (inputChar === 'c' || inputChar === 'd')) {
      exit()
      return
    }
    // 回车提交
    if (key.return) {
      const text = input.trim()
      if (text === '/exit' || text === '/quit') {
        exit()
        return
      }
      if (text) {
        setHistory(h => [...h, { role: 'user', text }])
        // M2: 这里会 await runQueryLoop(text, ...)
        // M1: 只回显"（M1 暂未接入模型）"
        setHistory(h => [
          ...h,
          { role: 'assistant', text: `（M1 骨架模式：你说了 "${text}"，模型接入在 M2）` },
        ])
      }
      setInput('')
      return
    }
    // 退格
    if (key.backspace || key.delete) {
      setInput(s => s.slice(0, -1))
      return
    }
    // 普通字符（忽略 ctrl 组合）
    if (!key.ctrl && !key.meta && inputChar && inputChar.length === 1) {
      setInput(s => s + inputChar)
    }
  })

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          fuckcode <Text dimColor>v{version}</Text>
        </Text>
        {modelName && (
          <Text dimColor>模型: {modelName}</Text>
        )}
        <Text dimColor>
          原生中文交互的终端 AI 编码工具
        </Text>
      </Box>

      <Newline />

      {history.map((m, i) => (
        <Box key={i} flexDirection="column">
          <Text color={m.role === 'user' ? 'green' : 'blue'}>
            {m.role === 'user' ? '你' : 'fuckcode'}: {m.text}
          </Text>
        </Box>
      ))}

      <Box marginTop={1}>
        <Text color="green">❯ </Text>
        <Text>{input}</Text>
        <Text color="gray">▋</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Ctrl+C / Ctrl+D 退出 · 输入 /exit 退出 · M2 将接入模型
        </Text>
      </Box>
    </Box>
  )
}
```

说明：
- `useInput` 是 Ink 的键盘输入 hook，每个按键触发回调
- `key.ctrl && inputChar === 'c'` — Ink 里 Ctrl+C 表现为 `ctrl=true, inputChar='c'`
- `key.return` — 回车键
- `key.backspace` — 退格
- `useApp().exit()` — 优雅退出 Ink（触发 App.tsx 的 `instance.wait()` resolve）
- **M1 不接入 LLM**——回显一条提示消息。M2 改这里接 `queryLoop`
- `❯` 和 `▋` 模拟输入框光标

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/repl/Repl.test.tsx`
Expected: 2 tests PASS

- [ ] **Step 5: 全量测试**

Run: `bun test`
Expected: 全部 PASS（Paths 4 + Config 4 + Logger 2 + Repl 2 = 12 tests）

- [ ] **Step 6: 类型检查**

Run: `bun run typecheck`
Expected: 0 错误

- [ ] **Step 7: Commit**

```bash
git add src/repl/Repl.tsx tests/repl/Repl.test.tsx
git commit -m "feat(repl): M1 空 REPL（欢迎语 + 输入框 + 回显）

- useInput 处理键盘（Ctrl+C/D 退出、回车提交、退格）
- /exit /quit 斜杠命令
- M1 回显不接模型，M2 改这里接 queryLoop"
```

---

## Task 11: 端到端冒烟 + 文档

**Files:**
- Create: `README.md`

- [ ] **Step 1: 端到端冒烟——启动 REPL**

Run（手动交互）:
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run src/cli.tsx
```
Expected:
- 看到带边框的欢迎语：`fuckcode v0.1.0` / `模型: claude-sonnet-4-5-20250929` / `原生中文交互...`
- 看到输入框 `❯ ▋`
- 输入 `你好` 回车 → 出现 `你: 你好` 和 `fuckcode: （M1 骨架模式：...）`
- 输入 `/exit` 回车 → 退出

如果界面乱码（中文宽度问题），Ink 7 默认支持宽字符，应该没问题；若有问题检查终端是否 UTF-8。

- [ ] **Step 2: 验证 bin 命令可执行**

Run:
```bash
export PATH="$HOME/.bun/bin:$PATH"
chmod +x bin/fuckcode.js
bun bin/fuckcode.js
```
Expected: 同 Step 1 的欢迎界面（证明 bin 入口转发链路通）。

⚠️ 全局安装（`bun link`）会在 M6 之后做，M1 只要本地能跑即可。

- [ ] **Step 3: 写 README.md**

```markdown
# fuckcode

> 原生中文交互的终端 AI 编码工具。覆盖从需求到开发测试的完整流程。

**当前状态：M1 骨架（v0.1.0 开发中）** — 仅空 REPL，模型接入在 M2。

## 安装与运行

### 前置要求

- [Bun](https://bun.sh) ≥ 1.2
- macOS（M1 仅支持 Mac）

### 开发模式运行

\`\`\`bash
bun install
bun run dev        # 即 bun run src/cli.tsx
\`\`\`

### 命令行用法

\`\`\`bash
fuckcode                 # 进入交互 REPL
fuckcode --version       # 显示版本
fuckcode --verbose       # 详细日志
fuckcode "你的提示"      # 一次性模式（M2 支持）
\`\`\`

## 架构

四层（详见 [设计文档](docs/superpowers/specs/2026-07-13-fuckcode-mvp-design.md)）：

- **TUI 层**（Ink/React）— REPL 交互
- **Agent Loop 层**（async generator）— queryLoop + 流式工具执行（M2+）
- **Service 层**（Effect.ts）— Config / Logger / Session / Permission
- **工具层**（async）— Read/Write/Edit/Bash/Glob/Grep（M3+）

## 配置

\`~/.fuckcode/config.json\`：

\`\`\`json
{
  "model": "claude-sonnet-4-5-20250929",
  "apiKey": "sk-ant-...",
  "permissions": {
    "allow": ["Read", "Glob", "Grep"],
    "ask": ["Edit(src/**)"],
    "deny": ["Bash(rm -rf*)"]
  }
}
\`\`\`

API Key 也可走 \`ANTHROPIC_API_KEY\` 环境变量。

## 开发

\`\`\`bash
bun test              # 运行测试
bun run typecheck     # 类型检查
\`\`\`

## 路线图

- ✅ M1 骨架（本版本）
- ⬜ M2 LLM + 基础 loop
- ⬜ M3 工具系统（Read/Glob/Grep）
- ⬜ M4 写工具 + 权限
- ⬜ M5 会话 + 压缩
- ⬜ M6 打磨发布

详见 [MVP 设计文档](docs/superpowers/specs/2026-07-13-fuckcode-mvp-design.md)。
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README（安装、运行、架构、配置、路线图）"
```

- [ ] **Step 5: 最终全量验证**

Run:
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test && bun run typecheck
```
Expected: 全部测试 PASS + 0 类型错误

- [ ] **Step 6: 在对话中报告 M1 完成状态**

向用户报告：
- ✅ 11 个 Task 全部完成
- ✅ 12 个测试 PASS、类型检查 0 错误
- ✅ `bun run src/cli.tsx` 能启动 REPL，交互正常
- 📍 当前在 `chore/fuckcode-design-doc` 分支，建议开 `feat/m2-llm-loop` 进入下个里程碑

---

## 自审清单（执行前运行）

实现完所有 Task 后，对照本清单确认：

- [ ] **spec 覆盖**：M1 范围（骨架 + runtime + Config/Logger + Ink 空 REPL + bin 命令）全部有对应 Task
- [ ] **无占位符**：无 TBD / TODO / "实现细节略"
- [ ] **类型一致**：`ConfigValue`、`LoggerService`、`ReplProps`、`StartReplOpts` 在各 Task 间名称一致
- [ ] **依赖顺序**：Task 7b Config 用于 Task 6 runtime → Task 6 runtime 用于 Task 9 App；Task 8 LoggerLive 改动会回头改 Task 6（已注明）
- [ ] **可验证**：每个 Task 都有"运行 X，期望 Y"步骤
- [ ] **测试覆盖**：Paths 4 + Config 4 + Logger 2 + Repl 2 = 12 tests

---

## 执行注意事项

1. **Bun API 校准**：effect@3.21.4 的 `Runtime.make` / `Context.Tag` / `Layer.effect` 具体签名实现时以实际为准，Task 6 给了主写法 + 备选写法，遇到类型不匹配切备选。
2. **路径别名**：`@/` 在 tsconfig.json 配置，但 Bun 运行时需要 import 带 `.js` 后缀（ESM 规范），如 `@/services/Config.js`——实际文件是 `.ts`，Bun 会自动解析。`verbatimModuleSyntax: true` 强制 type-only import 用 `import type`。
3. **stderr 日志**：Logger 写 stderr 是硬约束，否则会破坏 Ink 渲染。Task 8 已遵守。
4. **Ctrl+C 行为**：M1 让 Ctrl+C 直接退出（简化），M4 改为中断当前 queryLoop 轮次。
5. **不要提前实现 M2+**：queryLoop、ApiClient、工具——M1 严格只做骨架，YAGNI。
