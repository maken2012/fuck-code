// src/instruction/agentsMd.ts
// AGENTS.md / CLAUDE.md 指令文件加载。
// 照搬 opencode 的设计：从 cwd 向上查找 AGENTS.md，把内容注入 system prompt。
// 这让团队能用一份文件约定"这个项目 agent 该怎么干活"（代码风格、测试命令、禁忌等）。
import { readFile, stat } from 'node:fs/promises'
import { resolve, dirname, basename } from 'node:path'

// 支持的指令文件名（按优先级）
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.fuckcode/AGENTS.md']

// 从 cwd 向上逐级查找指令文件，合并所有找到的内容（祖先级也注入）
// 与 opencode 不同：我们合并所有层级（不只第一个），让"全局约定 + 项目细化"都能生效
export async function loadInstructions(cwd: string): Promise<string | null> {
  const found: { path: string; content: string }[] = []

  // 检查某目录下的指令文件
  async function checkDir(dir: string): Promise<void> {
    for (const name of INSTRUCTION_FILES) {
      const fullPath = resolve(dir, name)
      try {
        await stat(fullPath)
        const content = await readFile(fullPath, 'utf8')
        found.push({ path: fullPath, content: content.trim() })
        return // 同目录只取第一个匹配的文件名
      } catch {
        // 不存在，继续
      }
    }
  }

  // 从 cwd 向上遍历到文件系统根（dirname(dir) === dir 表示到根了）
  let dir = resolve(cwd)
  while (true) {
    await checkDir(dir)
    const parent = dirname(dir)
    if (parent === dir) break // 到文件系统根
    dir = parent
  }

  if (found.length === 0) return null

  // 反转（祖先在前，项目在后，让项目级覆盖视觉上更近）+ 拼接
  const ordered = found.reverse()
  const sections = ordered.map((f) => {
    const rel = f.path.replace(resolve(cwd), '.').replace(/^\.\//, '')
    return `# 项目指令（${rel}）\n\n${f.content}`
  })
  return sections.join('\n\n---\n\n')
}

// 便捷：判断当前目录是否含指令文件（用于 /init 引导）
export async function hasInstructions(cwd: string): Promise<boolean> {
  return (await loadInstructions(cwd)) !== null
}

// 生成初始 AGENTS.md 模板（/init 命令用）
export function generateTemplate(cwd: string): string {
  const projectName = basename(resolve(cwd))
  return `# AGENTS.md - ${projectName}

> 这个文件指导 fuckcode（及其他 AI agent）在本项目里如何工作。
> 修改它会直接影响 agent 的行为。提交到 git 让全团队共享。

## 项目概述
${projectName} 是 ___（一句话描述）___。

## 代码风格
- ___（缩进、命名、注释密度等约定）___

## 常用命令
- 测试：\`___\`（如 bun test / npm test）
- 构建：\`___\`
- Lint：\`___\`

## agent 工作约定
- 修改前先读相关文件
- 改完跑测试确认
- ___（其他项目特定的约定）___

## 禁忌
- 不要修改 ___（如 .env、lock 文件、生成的代码）
- ___
`
}
