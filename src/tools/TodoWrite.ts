// src/tools/TodoWrite.ts
// TodoWrite 任务跟踪工具。照搬 Claude Code 设计：模型用它管理多步任务的进度。
// 强制单一 in_progress，pending/in_progress/completed 三态，带 content（祈使句）+ activeForm（进行时）。
// 这是让模型"不丢步骤"的关键机制——长任务（重构、迁移、debug）尤其有用。
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'

const Todo = z.object({
  content: z.string().describe('任务描述（祈使句，如"修改认证模块"）'),
  status: z.enum(['pending', 'in_progress', 'completed']).describe('任务状态'),
  activeForm: z.string().optional().describe('进行时态（如"正在修改认证模块"），用于 UI 显示'),
})
type TodoType = z.infer<typeof Todo>

const TodoWriteInput = z.object({
  todos: z.array(Todo).describe('完整的任务列表（每次调用传全量，不是增量）'),
})
type TodoWriteInputType = z.infer<typeof TodoWriteInput>

// 全局 todo 状态（供 UI 读取渲染）。单进程 CLI 只有一个活跃 todo list。
let currentTodos: TodoType[] = []

export function getCurrentTodos(): TodoType[] {
  return currentTodos
}

export const TodoWriteTool = buildTool<TodoWriteInputType>({
  name: 'TodoWrite',
  description: '管理任务清单（跟踪多步骤任务的进度）',
  prompt: `管理你的任务清单。对 3 步以上的复杂任务，用它跟踪进度，避免遗漏步骤。

参数：
- todos（必填）：**完整的任务列表**，每次调用都传全量（不是增量更新）。每个 todo 含：
  - content（必填）：任务描述，用祈使句（"修改 X"、"测试 Y"）
  - status（必填）：pending / in_progress / completed
  - activeForm（可选）：进行时态（"正在修改 X"），用于实时显示

规则：
1. **同时只能有一个 in_progress**——开始下一个前先把当前的标 completed
2. **测试没过不许标 completed**——只有验证通过才算完成
3. 按依赖顺序排列（被依赖的在前）
4. 任务完成或取消时立即更新清单（不要等到最后批量改）

何时用：
- 实现 3+ 步的功能（重构、迁移、修复杂 bug）
- 用户给了明确的多点需求
- plan 模式产出的计划，转成 todo 逐项执行

何时不用：
- 1-2 步的简单任务（直接做就行）
- 探索性任务（用 Task 子 agent）
- 纯问答

最佳实践：先创建全部 pending，开始第一项时标 in_progress，做完标 completed 并标下一项 in_progress，循环到全部 completed。`,
  inputSchema: TodoWriteInput,
  jsonSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            activeForm: { type: 'string' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  isReadOnly: () => true, // 只改内存状态，不碰文件，安全
  isConcurrencySafe: () => true,

  async execute(input) {
    // 深度比对第 24 轮: 状态机约束（对标 Claude Code）

    // 校验 1: 最多一个 in_progress
    const inProgress = input.todos.filter((t) => t.status === 'in_progress')
    if (inProgress.length > 1) {
      return {
        ok: false,
        error: `同时只能有一个 in_progress 任务，当前有 ${inProgress.length} 个：${inProgress.map((t) => t.content).join('、')}`,
        isError: true,
      }
    }

    // 校验 2: completed 不允许回退（对标 Claude Code 单向状态机）
    if (currentTodos.length > 0) {
      for (const newTodo of input.todos) {
        const oldTodo = currentTodos.find((t) => t.content === newTodo.content)
        if (oldTodo && oldTodo.status === 'completed' && newTodo.status !== 'completed') {
          return {
            ok: false,
            error: `任务"${newTodo.content}"已标记 completed，不允许回退到 ${newTodo.status}。已完成的任务应该保持 completed 状态。`,
            isError: true,
          }
        }
      }
    }

    currentTodos = input.todos

    // 深度比对第 24 轮: 进度条渲染（对标 Claude Code 进度展示）
    const completed = input.todos.filter((t) => t.status === 'completed').length
    const inProgressCount = input.todos.filter((t) => t.status === 'in_progress').length
    const pending = input.todos.filter((t) => t.status === 'pending').length
    const total = input.todos.length
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0
    // 进度条：█████░░░░░ 50%
    const filled = Math.round((pct / 100) * 10)
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled)

    const formatted = input.todos
      .map((t, i) => {
        const mark = t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '
        const activeText = t.activeForm && t.status === 'in_progress' ? ` (${t.activeForm})` : ''
        return `${i + 1}. [${mark}] ${t.content}${activeText}`
      })
      .join('\n')

    return {
      ok: true,
      data: `[${bar}] ${pct}% (${completed}/${total} 完成 · ${inProgressCount} 进行中 · ${pending} 待办)\n\n${formatted}`,
    }
  },
})
