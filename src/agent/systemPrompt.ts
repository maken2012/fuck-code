// src/agent/systemPrompt.ts
// 中文 system prompt。base 段（可缓存）+ tool section 段。
// M6: anthropic.ts 在 systemCacheable=true 时会给 system 加 cache_control，
// base 段跨轮稳定可命中 prompt cache。
// v0.3: AGENTS.md 指令文件注入（项目级行为约定）。
import type { Tool } from '@/tools/Tool.js'
import { loadInstructions } from '@/instruction/agentsMd.js'
import { loadMemories, formatMemoriesForPrompt, findRelevantMemories } from '@/instruction/memory.js'

export interface BuildSystemPromptOpts {
  /** M3：可用工具列表。每个工具的 prompt 会拼进 system prompt 末尾。 */
  tools?: Tool[]
  /** v1.8：用户当前输入，用于 findRelevantMemories 按相关性筛选记忆 */
  userQuery?: string
}

// 缓存已加载的指令（启动期加载一次，避免每次 queryLoop 都读文件）
let cachedInstructions: string | null | undefined
async function getInstructions(): Promise<string | null> {
  if (cachedInstructions === undefined) {
    cachedInstructions = await loadInstructions(process.cwd()).catch(() => null)
  }
  return cachedInstructions
}

// 同步版：返回缓存值（首次可能为 undefined，queryLoop 首轮前应先 await preloadInstructions）
export function getCachedInstructions(): string | null {
  return cachedInstructions ?? null
}

export async function preloadInstructions(): Promise<void> {
  cachedInstructions = await loadInstructions(process.cwd()).catch(() => null)
}

export async function buildSystemPrompt(opts?: BuildSystemPromptOpts): Promise<string> {
  const base = `你叫 fuckcode，是一个运行在终端的 AI 编码助手。你会通过工具读取文件、修改代码、运行命令来帮助用户完成开发任务。

# 核心原则
- 用中文回复（除非用户用英文提问或代码相关内容必须用英文）
- 回答简洁直接，不要啰嗦的免责声明或客套话
- 涉及代码时给出具体可执行的方案，不要泛泛而谈
- 不确定时坦诚说明，不要编造

# 工具使用
- 需要查看文件内容、搜索代码时，主动调用对应工具，不要凭空猜测
- 修改文件前必须先用 Read 读取（Edit/Write 工具会强制校验"已读"状态）
- 工具入参严格按其说明填写（如 Read 的 file_path 必须是绝对路径）
- 工具返回错误时不要重复调用相同入参，先分析错误原因再调整
- 优先用 Edit 做精确替换，整文件重写只在创建新文件时用 Write

# 编码约定
- 改动遵循现有代码风格（命名、缩进、注释密度）
- 给出的代码要能直接用，不要省略关键部分用 "..." 占位
- 运行测试或 lint 用 Bash 工具，不要假设结果

# 当前环境
- 工作目录：${process.cwd()}
- 操作系统：${process.platform}
- 运行时：Bun ${Bun.version}`

  // v0.3: AGENTS.md 指令文件（如有）
  const instructions = await getInstructions()
  const instructionSection = instructions ? `\n\n# 项目指令（AGENTS.md）\n以下指令由项目提供，优先级高于上面的默认约定：\n\n${instructions}` : ''

  // v1.5: 记忆注入（跨会话持久化的偏好/约定）
  // v1.5+v1.8: 记忆注入。用 findRelevantMemories 按 userQuery 筛选（避免全量爆上下文）
  const allMemories = await loadMemories(process.cwd()).catch(() => [])
  const memories = opts?.userQuery ? findRelevantMemories(allMemories, opts.userQuery) : allMemories
  const memorySection = formatMemoriesForPrompt(memories)

  const toolSection = opts?.tools && opts.tools.length > 0
    ? `\n\n# 可用工具\n\n${opts.tools
        .map((t) => `## ${t.name}\n\n${t.prompt}`)
        .join('\n\n')}`
    : ''

  return base + instructionSection + memorySection + toolSection
}
