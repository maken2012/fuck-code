// src/agent/planPrompt.ts
// plan 模式的专用 system prompt 增强器。
// 深度比对第 30 轮: 计划文件持久化 + plan 完成提示 + Bash 只读命令允许
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

export const PLAN_MODE_INSTRUCTION = `
# 当前运行在 PLAN（计划）模式

你现在处于只读的计划模式，不能修改任何文件或运行写操作。你的任务是产出一分清晰的实施计划，而不是直接动手改代码。

## 工作流程

1. **理解需求**：用自己的话复述用户的需求，确认你理解正确（有歧义就指出）
2. **调研现状**：用 Read/Glob/Grep 工具充分了解相关代码、依赖、现有实现
3. **提出方案**：给出技术方案，包含：
   - 改动范围（哪些文件、哪些模块）
   - 实现步骤（按执行顺序，每步可独立验证）
   - 关键决策点（如有多个选择，列出 trade-off 和你的推荐）
4. **风险评估**：可能的坑、兼容性影响、性能影响、测试策略
5. **验收标准**：每步完成的判断依据（如"运行 X 命令应输出 Y"）

## 输出格式

用 markdown 标题分节：
\`\`\`
## 需求理解
（复述 + 澄清问题）

## 现状分析
（基于工具调研的关键发现，引用具体 file:line）

## 实施方案
### 步骤 1: ...
### 步骤 2: ...

## 风险与权衡
- ...

## 验收标准
- [ ] ...
\`\`\`

## 原则
- 不要泛泛而谈，每个步骤都要具体到"改哪个文件的哪段代码"
- 引用代码时给出 file_path:line_number
- 如果需求本身有问题（矛盾、不可行、有更好替代），直接指出
- 计划是给后续执行用的——写清楚到另一个开发者（或你自己切回执行模式后）能照着做
- **完成后提示用户**：计划产出后，建议用户用 /workflow 或直接对话来执行计划
`

// 深度比对第 30 轮: 计划文件持久化（对标 opencode .opencode/plans/*.md）
export async function savePlan(cwd: string, requirement: string, plan: string): Promise<string> {
  const plansDir = resolve(cwd, '.fuckcode', 'plans')
  await mkdir(plansDir, { recursive: true })
  const timestamp = Date.now()
  const date = new Date(timestamp).toISOString().slice(0, 19).replace(/[:.]/g, '-')
  const shortName = requirement.slice(0, 30).replace(/[^\w\u4e00-\u9fa5]/g, '_')
  const fileName = `${date}-${shortName}.md`
  const filePath = resolve(plansDir, fileName)
  const content = `# 实施计划：${requirement}

> 生成时间：${new Date(timestamp).toLocaleString('zh-CN')}
> 模式：PLAN

${plan}
`
  await writeFile(filePath, content, 'utf8')
  return filePath
}

// 深度比对第 30 轮: plan 模式下允许的只读 Bash 命令（对标 opencode plan agent 工具白名单）
export const PLAN_ALLOWED_BASH = [
  'git status', 'git diff', 'git log', 'git branch', 'git show', 'git remote',
  'ls', 'cat', 'head', 'tail', 'wc', 'file', 'find', 'which', 'echo',
  'node --version', 'bun --version', 'npm --version', 'pnpm --version',
  'tsc --version', 'rg --version',
]

export function isPlanAllowedBash(command: string): boolean {
  const cmd = command.trim()
  return PLAN_ALLOWED_BASH.some((allowed) => cmd.startsWith(allowed))
}

