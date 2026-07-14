// src/tools/Skill.ts
// Skill 工具。模型用它按需加载某个 skill 的详细内容。
// 启动时 system prompt 只注入 skill 的 name+description（让模型知道有哪些），
// 模型判断需要时调 skill({name}) 加载完整正文。
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'
import { loadSkillContent } from '@/instruction/skills.js'

const SkillInput = z.object({
  name: z.string().describe('要加载的 skill 名（从 system prompt 的"可用 Skill"列表里选）'),
})
type SkillInputType = z.infer<typeof SkillInput>

export const SkillTool = buildTool<SkillInputType>({
  name: 'Skill',
  description: '加载某个 skill 的详细内容',
  prompt: `加载一个 skill 的完整内容（领域知识、框架用法、调试流程等）。

参数：
- name（必填）：skill 名（从 system prompt 里的"可用 Skill"列表选）

何时用：
- system prompt 里列出了可用 skill 及其简述
- 当你判断需要某个 skill 的详细知识时，用它加载完整内容
- 加载后按 skill 内容指导你的工作

不要：
- 无脑加载所有 skill（按需）
- 加载后不遵循 skill 内容`,
  inputSchema: SkillInput,
  jsonSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'skill 名' },
    },
    required: ['name'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async execute(input, ctx) {
    const content = await loadSkillContent(ctx.cwd, input.name)
    if (!content) {
      return { ok: false, error: `skill "${input.name}" 不存在。检查 .fuckcode/skills/${input.name}/SKILL.md` , isError: true }
    }
    return { ok: true, data: content }
  },
})
