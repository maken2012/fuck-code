// src/instruction/skills.ts
// Skill 系统（照 Claude Code skills/ + opencode skill/）。
// Skill 是自包含的领域知识包：.fuckcode/skills/<name>/SKILL.md
// frontmatter: name / description / effort（何时用）
// 正文：详细指令（框架用法、内部约定、调试流程等）
//
// 与 AGENTS.md/记忆的区别：
// - AGENTS.md：全局行为约定（始终生效）
// - 记忆：跨会话偏好/事实（始终注入相关项）
// - Skill：按需加载的领域知识（模型判断需要时才用 skill 工具读）
//
// 加载策略：启动时扫描 skill 目录，把每个 skill 的 name+description 注入 system prompt
// （让模型知道有哪些 skill 可用），正文按需通过 skill 工具加载。
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface Skill {
  name: string              // 唯一标识（目录名）
  description: string       // 一句话描述（注入 system prompt 让模型知道何时用）
  effort?: string           // 可选：调用时覆盖模型 effort（如 'high'/'low'）
  content: string           // SKILL.md 正文（详细知识）
  dir: string               // skill 目录路径
}

const SKILL_DIRS = ['.fuckcode/skills', '.claude/skills', '.agents/skills']

// 解析 SKILL.md
async function parseSkill(skillDir: string, name: string): Promise<Skill | null> {
  const skillMdPath = resolve(skillDir, 'SKILL.md')
  try {
    const raw = await readFile(skillMdPath, 'utf8')
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    let description = ''
    let effort: string | undefined
    let content = raw
    if (fmMatch) {
      const fm = fmMatch[1] ?? ''
      content = (fmMatch[2] ?? '').trim()
      const descMatch = fm.match(/^description:\s*(.+)$/m)
      const effortMatch = fm.match(/^effort:\s*(.+)$/m)
      description = descMatch?.[1]?.trim() ?? ''
      effort = effortMatch?.[1]?.trim()
    }
    return { name, description, effort, content, dir: skillDir }
  } catch {
    return null
  }
}

// 扫描所有 skill 目录，加载 skill 列表
export async function loadSkills(cwd: string): Promise<Skill[]> {
  const skills: Skill[] = []
  const seen = new Set<string>()

  for (const skillDirRel of SKILL_DIRS) {
    const skillDir = resolve(cwd, skillDirRel)
    try {
      await stat(skillDir)
    } catch {
      continue // 目录不存在
    }
    // 扫描子目录（每个子目录是一个 skill）
    const pattern = new Bun.Glob('*/SKILL.md')
    try {
      for await (const match of pattern.scan({ cwd: skillDir, absolute: false })) {
        const name = match.split('/')[0] ?? ''
        if (!name || seen.has(name)) continue
        seen.add(name)
        const skill = await parseSkill(resolve(skillDir, name), name)
        if (skill) skills.push(skill)
      }
    } catch {
      // 扫描失败跳过
    }
  }
  return skills
}

// 把 skill 列表格式化成 system prompt 片段（只 name+description，不全量注入正文）
export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return ''
  const lines = skills.map((s) => {
    const effortTag = s.effort ? ` [effort:${s.effort}]` : ''
    return `- **${s.name}**${effortTag}：${s.description}`
  })
  return `\n\n# 可用 Skill（按需用 skill 工具加载详细内容）\n${lines.join('\n')}\n\n需要某个 skill 的详细内容时，用 skill 工具传入 skill 名加载。`
}

// 加载单个 skill 的完整内容（skill 工具调用）
export async function loadSkillContent(cwd: string, name: string): Promise<string | null> {
  for (const skillDirRel of SKILL_DIRS) {
    const skillMdPath = resolve(cwd, skillDirRel, name, 'SKILL.md')
    try {
      const raw = await readFile(skillMdPath, 'utf8')
      const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)
      return fmMatch ? (fmMatch[1] ?? '').trim() : raw
    } catch {
      continue
    }
  }
  return null
}
