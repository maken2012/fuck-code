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
  effort?: string               // 深度比对第 64 轮: frontmatter effort（覆盖模型推理深度，对标 opencode/Claude Code skill effort）
  template: string              // 正文（含 $ARGUMENTS / $1 占位符）
  filePath: string
  hints?: string                // 深度比对第 43 轮: 自动提取的参数提示（如 '<文件名>'）
}

// 解析 frontmatter + 正文
function parseCommandFile(content: string, name: string, filePath: string): CustomCommand {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  let description: string | undefined
  let model: string | undefined
  let effort: string | undefined
  let template = content
  if (frontmatterMatch) {
    const fm = frontmatterMatch[1] ?? ''
    template = (frontmatterMatch[2] ?? '').trim()
    const descMatch = fm.match(/^description:\s*(.+)$/m)
    const modelMatch = fm.match(/^model:\s*(.+)$/m)
    const effortMatch = fm.match(/^effort:\s*(.+)$/m)
    description = descMatch?.[1]?.trim()
    model = modelMatch?.[1]?.trim()
    effort = effortMatch?.[1]?.trim()
  }
  // 深度比对第 43 轮: 自动提取参数提示（对标 opencode hints()）
  const hints = extractHints(template)
  return { name, description, model, effort, template, filePath, hints }
}

// 深度比对第 43 轮: 从模板正文提取 $N/$ARGUMENTS 并生成参数提示
// 如模板含 $1 $2 → hints = '<参数1> <参数2>'
// 如模板含 $ARGUMENTS → hints = '<参数>'
export function extractHints(template: string): string | undefined {
  const positionalParams = new Set<number>()
  let hasArguments = false

  // 扫描 $1 $2 $ARGUMENTS（排除 shell 执行的 !`...` 里的）
  const cleaned = template.replace(/!`[^`]+`/g, '') // 先去掉 shell 执行段
  const matches = cleaned.matchAll(/\$(\d+|\{(\d+)\}|ARGUMENTS)/g)
  for (const m of matches) {
    const token = m[1] ?? ''
    if (token === 'ARGUMENTS') {
      hasArguments = true
    } else {
      positionalParams.add(parseInt(token) || 0)
    }
  }

  if (hasArguments && positionalParams.size === 0) {
    return '<参数>'
  }
  if (positionalParams.size > 0) {
    const sorted = [...positionalParams].sort((a, b) => a - b)
    return sorted.map((n) => `<参数${n}>`).join(' ')
  }
  return undefined
}

// 从 cwd/.fuckcode/commands/ 加载所有自定义命令
// 深度比对第 51 轮: 冲突检测——与内置命令同名时警告（对标 opencode plugin conflict detection）
const BUILTIN_COMMANDS = new Set([
  'workflow', 'goal', 'plan', 'context', 'diff', 'rewind', 'cost',
  'model', 'config', 'less-perms', 'skills', 'reload-skills', 'init',
  'agents', 'sessions', 'resume', 'clear', 'help', 'exit', 'quit',
])

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
        // 深度比对第 51 轮: 与内置命令同名时警告
        if (BUILTIN_COMMANDS.has(name)) {
          process.stderr.write(`[WARN] 自定义命令 ${name}.md 与内置命令同名，内置优先。换个文件名。\n`)
          continue
        }
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
// 深度比对第 37 轮: 增强模板——支持 $ARGUMENTS/$N + !命令 shell 执行（对标 opencode）
export function renderTemplate(template: string, args: string): string {
  const parts = args.split(/\s+/).filter(Boolean)
  let result = template.replace(/\$ARGUMENTS/g, args)
  parts.forEach((part, i) => {
    result = result.replace(new RegExp(`\\$${i + 1}`, 'g'), part)
  })
  // 未提供的 $N 替换为空
  result = result.replace(/\$\d+/g, '')

  // 深度比对第 37 轮: !命令 shell 执行（对标 opencode !`command` 语法）
  // 匹配 !`command` 或 !``command`` 形式，执行命令并替换为输出
  result = result.replace(/!`([^`]+)`/g, (_, cmd: string) => {
    try {
      const { execSync } = require('node:child_process')
      const output = execSync(cmd, { encoding: 'utf8', timeout: 10000, cwd: process.cwd() })
      return output.trim()
    } catch {
      return `[命令执行失败: ${cmd}]`
    }
  })

  return result
}
