// src/instruction/customCommands.ts
// 自定义斜杠命令加载。照搬 opencode 设计：
// 扫描 .fuckcode/commands/*.md，frontmatter 含 description/model，正文是 template（支持 $ARGUMENTS/$N）
// 用户输入 /xxx 时，匹配命令，把 template 作为 prompt 发给 queryLoop。
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { glob } from 'node:fs/promises'

export interface CustomCommand {
  name: string                  // 命令名（不含 /，来自文件名）
  description?: string          // frontmatter description
  model?: string                // frontmatter model（覆盖当前模型）
  template: string              // 正文（含 $ARGUMENTS / $1 占位符）
  filePath: string
}

// 解析 frontmatter + 正文
function parseCommandFile(content: string, name: string, filePath: string): CustomCommand {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  let description: string | undefined
  let model: string | undefined
  let template = content
  if (frontmatterMatch) {
    const fm = frontmatterMatch[1] ?? ''
    template = (frontmatterMatch[2] ?? '').trim()
    const descMatch = fm.match(/^description:\s*(.+)$/m)
    const modelMatch = fm.match(/^model:\s*(.+)$/m)
    description = descMatch?.[1]?.trim()
    model = modelMatch?.[1]?.trim()
  }
  return { name, description, model, template, filePath }
}

// 从 cwd/.fuckcode/commands/ 加载所有自定义命令
export async function loadCustomCommands(cwd: string): Promise<CustomCommand[]> {
  const commandsDir = resolve(cwd, '.fuckcode', 'commands')
  try {
    await stat(commandsDir)
  } catch {
    return [] // 目录不存在
  }

  const commands: CustomCommand[] = []
  // 扫描 .md 文件
  const pattern = new Bun.Glob('*.md')
  try {
    for await (const file of pattern.scan({ cwd: commandsDir, absolute: false })) {
      const name = file.replace(/\.md$/, '')
      const fullPath = resolve(commandsDir, file)
      try {
        const content = await readFile(fullPath, 'utf8')
        commands.push(parseCommandFile(content, name, fullPath))
      } catch {
        // 单个文件读失败跳过
      }
    }
  } catch {
    // glob 扫描失败返回空
  }
  return commands
}

// 渲染 template：替换 $ARGUMENTS / $1 $2 ...
export function renderTemplate(template: string, args: string): string {
  const parts = args.split(/\s+/).filter(Boolean)
  let result = template.replace(/\$ARGUMENTS/g, args)
  parts.forEach((part, i) => {
    result = result.replace(new RegExp(`\\$${i + 1}`, 'g'), part)
  })
  // 未提供的 $N 替换为空
  result = result.replace(/\$\d+/g, '')
  return result
}
