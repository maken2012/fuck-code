// src/instruction/memory.ts
// 记忆系统（照 Claude Code memdir 简化版）。
// 跨会话持久化用户偏好、项目约定、踩坑记录。
//
// 存储：.fuckcode/memory/MEMORY.md（索引）+ .fuckcode/memory/*.md（每条记忆独立文件）
// 每条记忆 frontmatter：name / description / type（preference/project/feedback/reference）
// 正文是详细内容。
//
// 加载：启动时读 MEMORY.md，把所有记忆的 name+description 注入 system prompt。
// v1.5 简化版全量注入（v1.6 加 findRelevantMemories 按相关性筛选，照 Claude Code side-query）。
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface Memory {
  name: string           // 唯一标识（也是文件名）
  description: string    // 一句话描述（注入 system prompt 让模型知道有这条记忆）
  type: 'preference' | 'project' | 'feedback' | 'reference'
  content: string        // 详细内容
  filePath: string
}

const MEMORY_DIR = '.fuckcode/memory'
const INDEX_FILE = 'MEMORY.md'

// 解析单条记忆文件
function parseMemoryFile(content: string, name: string, filePath: string): Memory {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  let description = ''
  let type: Memory['type'] = 'reference'
  let body = content
  if (fmMatch) {
    const fm = fmMatch[1] ?? ''
    body = (fmMatch[2] ?? '').trim()
    const descMatch = fm.match(/^description:\s*(.+)$/m)
    const typeMatch = fm.match(/^type:\s*(.+)$/m)
    description = descMatch?.[1]?.trim() ?? ''
    type = (typeMatch?.[1]?.trim() as Memory['type']) ?? 'reference'
  }
  return { name, description, type, content: body, filePath }
}

// 加载所有记忆
export async function loadMemories(cwd: string): Promise<Memory[]> {
  const memoryDir = resolve(cwd, MEMORY_DIR)
  try {
    await stat(memoryDir)
  } catch {
    return [] // 目录不存在
  }

  const memories: Memory[] = []
  const pattern = new Bun.Glob('*.md')
  try {
    for await (const file of pattern.scan({ cwd: memoryDir, absolute: false })) {
      if (file === INDEX_FILE) continue // 跳过索引文件本身
      const name = file.replace(/\.md$/, '')
      const fullPath = resolve(memoryDir, file)
      try {
        const content = await readFile(fullPath, 'utf8')
        memories.push(parseMemoryFile(content, name, fullPath))
      } catch {
        // 单个文件读失败跳过
      }
    }
  } catch {
    // glob 失败返回空
  }
  return memories
}

// 把记忆格式化成 system prompt 片段
export function formatMemoriesForPrompt(memories: Memory[]): string {
  if (memories.length === 0) return ''
  const lines = memories.map((m) => {
    const typeLabel = { preference: '偏好', project: '项目', feedback: '反馈', reference: '参考' }[m.type]
    return `- [${typeLabel}] ${m.name}：${m.description}\n  详细内容：${m.content.slice(0, 200)}${m.content.length > 200 ? '...' : ''}`
  })
  return `\n\n# 记忆（跨会话持久化）\n以下是之前积累的记忆，参考它们来保持一致性：\n\n${lines.join('\n')}`
}

// 保存新记忆（创建 .md 文件）
export async function saveMemory(
  cwd: string,
  name: string,
  description: string,
  type: Memory['type'],
  content: string,
): Promise<string> {
  const memoryDir = resolve(cwd, MEMORY_DIR)
  await mkdir(memoryDir, { recursive: true })
  const filePath = resolve(memoryDir, `${name}.md`)
  const fileContent = `---
name: ${name}
description: ${description}
type: ${type}
---

${content}`
  await writeFile(filePath, fileContent, 'utf8')
  return filePath
}

// 生成初始 MEMORY.md 索引模板
export function generateMemoryIndexTemplate(): string {
  return `# 记忆索引

> 这个目录存放跨会话持久化的记忆。每条记忆是一个 .md 文件。
> agent 启动时会读取所有记忆，注入 system prompt。
>
> 记忆类型：
> - preference：用户偏好（"用 bun 不用 npm"）
> - project：项目约定（"测试用 vitest"）
> - feedback：反馈教训（"不要修改生成的代码"）
> - reference：参考资料（"API 文档在 xxx"）

## 已有记忆

（agent 会自动列出，或运行 /memories 查看）
`
}
