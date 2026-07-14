// src/tools/AskUserQuestion.ts
// 结构化提问工具。模型用它向用户问选择题（比纯文本提问体验好）。
// 实现类似权限弹窗：yield ask 事件，Repl 渲染选项，用户选后 resolve。
// 但工具 execute 是 async 函数不能 yield——所以用全局 pending 队列 + Promise。
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'

// 深度比对第 33 轮: 加 recommended + preview 字段（对标 Claude Code AskUserQuestionTool）
const AskOption = z.object({
  label: z.string().describe('选项显示文本（简短）'),
  description: z.string().optional().describe('选项说明（详细）'),
  recommended: z.boolean().optional().describe('标记为推荐选项（UI 显示 "(推荐)"）'),
  preview: z.string().optional().describe('选项预览内容（ASCII/代码片段，供用户对比）'),
})
type AskOptionType = z.infer<typeof AskOption>

const AskQuestion = z.object({
  question: z.string().describe('要问用户的问题'),
  header: z.string().describe('简短标签（最多 12 字符）'),
  options: z.array(AskOption).min(2).max(4).describe('2-4 个选项'),
  multiSelect: z.boolean().optional().describe('允许多选（默认 false）'),
})
type AskQuestionType = z.infer<typeof AskQuestion>

// 全局 pending 提问（Repl 轮询消费）。单进程 CLI 同时只有一个。
export interface PendingQuestion {
  question: string
  header: string
  options: AskOptionType[]
  multiSelect: boolean
  resolve: (answers: string[]) => void
}
let pendingQuestion: PendingQuestion | null = null
const questionWaiters: Array<(q: PendingQuestion | null) => void> = []

export function takePendingQuestion(): Promise<PendingQuestion | null> {
  if (pendingQuestion) {
    const q = pendingQuestion
    pendingQuestion = null
    return Promise.resolve(q)
  }
  return new Promise((resolve) => {
    questionWaiters.push(resolve)
  })
}

function setQuestion(q: PendingQuestion): void {
  const waiter = questionWaiters.shift()
  if (waiter) waiter(q)
  else pendingQuestion = q
}

export const AskUserQuestionTool = buildTool<AskQuestionType>({
  name: 'AskUserQuestion',
  description: '向用户问选择题（方案分叉时用）',
  prompt: `当需要用户在多个方案间决策时，用结构化提问。

参数：
- question（必填）：完整的问题描述
- header（必填）：简短标签（最多 12 字符），如"缓存方案"
- options（必填）：2-4 个选项，每个含：
  - label（必填）：简短显示文本
  - description（可选）：详细说明
  - recommended（可选）：标记推荐选项（UI 显示 "(推荐)"）
  - preview（可选）：预览内容（代码片段/方案对比）
- multiSelect（可选）：允许多选，默认 false

何时用（深度比对第 82 轮增强）：
- 技术方案分叉需要用户拍板
- 需求有歧义需要澄清
- plan 模式确认实施方向
- 技术方案有多个合理选择，需要用户拍板
- 需求有歧义，需要用户澄清
- plan 模式里确认实施方向

何时不用：
- 答案你能自己合理判断（直接做）
- 只是简单的事实性问题（直接在文本里问）
- 用户明确说过"你决定就好"`,
  inputSchema: AskQuestion,
  jsonSchema: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      header: { type: 'string', maxLength: 12 },
      options: {
        type: 'array',
        minItems: 2,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            description: { type: 'string' },
            recommended: { type: 'boolean', description: '标记为推荐选项' },
            preview: { type: 'string', description: '选项预览（ASCII/代码片段）' },
          },
          required: ['label'],
        },
      },
      multiSelect: { type: 'boolean' },
    },
    required: ['question', 'header', 'options'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => false, // 要等用户，不能并行

  async execute(input) {
    const answers = await new Promise<string[]>((resolve) => {
      setQuestion({
        question: input.question,
        header: input.header,
        options: input.options,
        multiSelect: input.multiSelect ?? false,
        resolve,
      })
    })
    // 深度比对第 33 轮: 结果含推荐标记信息
    const selectedLabels = answers.map((a) => {
      const opt = input.options.find((o) => o.label === a)
      const isRecommended = opt?.recommended ? ' (推荐)' : ''
      return `${a}${isRecommended}`
    })
    return {
      ok: true,
      data: answers.length === 0
        ? '用户未选择（跳过）'
        : `用户选择了：${selectedLabels.join('、')}`,
    }
  },
})
