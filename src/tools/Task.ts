// src/tools/Task.ts
// Task 工具：让主 agent 派一个子 agent 执行独立任务（探索、研究、实现）。
// 照搬 Claude Code 的 AgentTool 思路（简化版）。
//
// 工作方式：
// 1. 主 agent 调 Task({ description, prompt, subagent_type? })
// 2. Task.execute 内部递归调 queryLoop，用一个专门的子 agent system prompt
// 3. 子 agent 用只读工具（Read/Glob/Grep）完成任务，产出文本结果
// 4. 结果作为 tool_result 返回给主 agent
//
// 子 agent 的上下文是隔离的（不带主对话历史），只看到自己的 prompt。
// 这让模型能并行探索多个方向，不污染主上下文。
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'
import { queryLoop } from '@/agent/queryLoop.js'
import { buildSystemPrompt } from '@/agent/systemPrompt.js'
import { getAllTools } from '@/tools/registry.js'
import type { ChatMessage } from '@/llm/types.js'
import type { ToolContext } from '@/tools/Tool.js'

const TaskInput = z.object({
  description: z.string().describe('一句话任务描述（5-15 字），用于让用户知道子 agent 在做什么'),
  prompt: z.string().describe('给子 agent 的详细任务指令'),
  subagent_type: z
    .enum(['explore', 'general', 'fork'])
    .optional()
    .describe('子 agent 类型：explore（只读探索，默认）/ general（通用，可写）/ fork（继承父上下文）'),
})
type TaskInputType = z.infer<typeof TaskInput>

// 子 agent 的 system prompt（比主 prompt 更聚焦：你是被派来完成具体任务的，做完汇报）
const SUBAGENT_SYSTEM_PREFIX = `你是一个被主 agent 派遣来执行具体任务的子 agent。

# 你的职责
- 你收到了一个明确的任务（在 user 消息里），你的唯一目标是完成它
- 用工具（Read/Glob/Grep）充分调研，给出具体、可验证的结果
- 不要寒暄、不要重复任务描述，直接产出成果
- 如果任务无法完成（信息不足、矛盾），说明原因

# 与主 agent 的关系
- 你看不到主对话的历史，只看到给你的任务（fork 模式除外，会继承上下文）
- 你的最终输出会被主 agent 读到，所以要完整、准确
- 引用代码时给 file_path:line_number`

// fork 模式专用 prompt
const FORK_SYSTEM_PREFIX = `你是一个 fork 子 agent，继承了主 agent 的完整对话上下文。

# 你的职责
- 你看到了主对话的完整历史（共享上下文）
- 基于已有上下文继续完成指定任务
- 适合"基于刚才的发现继续做"这类延续性任务
- 完成后把结果汇报给主 agent`


export const TaskTool = buildTool<TaskInputType>({
  name: 'Task',
  description: '派一个子 agent 执行独立任务（探索代码、研究方案、并行调研）',
  prompt: `派一个子 agent 在隔离的上下文中执行任务。子 agent 看不到主对话历史，只看到你给的 prompt，完成后把结果汇报给你。

适用场景：
- 探索不熟悉的代码库（"找出所有处理认证的文件"）
- 并行调研多个方案（"分别调研 A 和 B 两种实现方式"）
- 复杂的查找任务（"找到导致这个 bug 的具体代码路径"）
- 减少主上下文污染（把冗长的探索过程隔离在子 agent 里）

参数：
- description（必填）：5-15 字的任务简述，会显示给用户
- prompt（必填）：给子 agent 的详细任务指令。要足够具体，因为子 agent 没有主对话上下文
- subagent_type（可选）：explore（只读探索，默认，只能用 Read/Glob/Grep）或 general（通用）

使用建议：
- prompt 里说清"要找什么/要做什么/结果格式要求"
- 不要派子 agent 做你自己几步就能完成的小任务
- 多个独立任务可以连续派多个子 agent（它们各自隔离）`,
  inputSchema: TaskInput,
  jsonSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '5-15 字任务简述' },
      prompt: { type: 'string', description: '给子 agent 的详细任务指令' },
      subagent_type: { type: 'string', enum: ['explore', 'general', 'fork'], description: 'explore（只读，默认）/ general（可写）/ fork（继承父上下文）' },
    },
    required: ['description', 'prompt'],
  },
  // Task 本身是"读"操作（它调研），但内部子 agent 可能写（general 类型）
  // 保守起见不标记 isReadOnly，让权限管线对 Task 本身 ask
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  async execute(input, ctx) {
    const subagentType = input.subagent_type ?? 'explore'
    const isExplore = subagentType === 'explore'
    const isFork = subagentType === 'fork'

    // 子 agent 用独立 AbortController（子 agent 超时 120s）
    const subAc = new AbortController()
    const SUB_TIMEOUT = 120000
    const timeout = setTimeout(() => subAc.abort(), SUB_TIMEOUT)
    // 父 abort 也传播（深度比对第 16 轮：监听器用完要清理，防内存泄漏）
    const abortHandler = () => subAc.abort()
    ctx.abortSignal.addEventListener('abort', abortHandler, { once: true })

    // 子 agent 的工具集：
    // - explore：只给只读三件套
    // - general：给全部（不含 Task 防递归）
    // - fork：给全部（继承上下文，通常继续实现）
    const allTools = getAllTools().filter((t) => t.name !== 'Task')
    const subTools = isExplore
      ? allTools.filter((t) => t.name === 'Read' || t.name === 'Glob' || t.name === 'Grep')
      : allTools

    // 子 agent 的 system prompt
    const subPrefix = isFork ? FORK_SYSTEM_PREFIX : SUBAGENT_SYSTEM_PREFIX
    const subSystem =
      (await buildSystemPrompt({ tools: subTools })) + '\n\n' + subPrefix

    try {
      let subResult = ''
      let turn = 0
      const MAX_SUB_TURNS = 10

      // v1.7: fork 模式真正继承父对话历史（通过 ctx.parentHistory）
      // explore/general 用空 history（独立上下文），fork 用父 history（延续）
      const subHistory: ChatMessage[] = isFork ? (ctx.parentHistory ?? []) : []

      // v1.8: sidechain transcript——子 agent 用独立 session 文件持久化
      // 失败不阻塞（subSessionId 为 undefined 时 queryLoop 不持久化）
      let subSessionId: string | undefined
      try {
        const { createSession } = await import('@/services/Session.js')
        subSessionId = await createSession(ctx.cwd)
      } catch {
        // 无 session 也能跑
      }

      // 子 agent 的 mini queryLoop（复用 queryLoop 函数）
      for await (const event of queryLoop({
        history: subHistory,
        userInput: input.prompt,
        model: 'claude-sonnet-4-5-20250929', // 子 agent 默认用 sonnet（便宜够用）
        system: subSystem,
        signal: subAc.signal,
        cwd: ctx.cwd,
        tools: subTools,
        permissionMode: isExplore ? 'plan' : 'acceptEdits', // explore 只读；general 接受编辑
        permissions: { allow: [], ask: [], deny: [] },
        contextWindow: 200000,
        // v1.8: sidechain transcript——子 agent 用独立 session 文件，
        // 不污染主上下文（主 agent 只收 subResult 文本摘要）
        sessionId: subSessionId,
      })) {
        if (event.type === 'text_delta') {
          subResult += event.text
        } else if (event.type === 'turn_end') {
          turn++
        } else if (event.type === 'error') {
          // 子 agent 内部错误不传播，记录到结果
          subResult += `\n\n[子 agent 错误: ${event.error.message}]`
        } else if (event.type === 'aborted') {
          // 深度比对第 16 轮: 友好超时/中断提示
          const elapsed = Math.round(SUB_TIMEOUT / 1000)
          const reason = subAc.signal.aborted ? `超时（${elapsed}s）` : '用户中断'
          return {
            ok: false,
            error: `子 agent ${reason}。${subResult ? `部分结果:\n${subResult.slice(0, 2000)}` : '无输出。'}`,
            isError: true,
          }
        }
        if (turn >= MAX_SUB_TURNS) break
      }

      // 检查 ctx.abortSignal（父级中断）
      if (ctx.abortSignal.aborted) {
        return { ok: false, error: '父级已中断', isError: true }
      }

      // 深度比对第 16 轮: 子 agent 结果大小限制（防大结果污染主上下文）
      const MAX_SUB_RESULT = 10000
      let finalResult = subResult.trim() || '（子 agent 未产出文本）'
      if (finalResult.length > MAX_SUB_RESULT) {
        finalResult = finalResult.slice(0, MAX_SUB_RESULT) + '\n\n[子 agent 结果被截断——原长度 ' + finalResult.length + ' 字符]'
      }

      return {
        ok: true,
        data: finalResult,
      }
    } catch (e) {
      return { ok: false, error: `子 agent 执行失败: ${String(e)}`, isError: true }
    } finally {
      clearTimeout(timeout)
      // 深度比对第 16 轮: 清理 abort 监听器（防内存泄漏）
      ctx.abortSignal.removeEventListener('abort', abortHandler)
    }
  },
})
