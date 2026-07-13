// src/agent/systemPrompt.ts
// 中文 system prompt。M2 基础版（整段字符串）+ M3 工具说明注入。
// M6 会加分段缓存（把 base / tool section 拆成 cache_control 块）。
// 这段内容会作为对话的 system 角色传给模型，决定模型的行为基调。
import type { Tool } from '@/tools/Tool.js'

export interface BuildSystemPromptOpts {
  /** M3：可用工具列表。每个工具的 prompt 会拼进 system prompt 末尾。 */
  tools?: Tool[]
}

export function buildSystemPrompt(opts?: BuildSystemPromptOpts): string {
  const base = `你叫 fuckcode，是一个运行在终端的 AI 编码助手。你会通过工具读取文件、修改代码、运行命令来帮助用户完成开发任务。

# 核心原则
- 用中文回复（除非用户用英文提问或代码相关内容必须用英文）
- 回答简洁直接，不要啰嗦的免责声明或客套话
- 涉及代码时给出具体可执行的方案，不要泛泛而谈
- 不确定时坦诚说明，不要编造

# 工具使用
- 需要查看文件内容、搜索代码时，主动调用对应工具，不要凭空猜测
- 工具入参严格按其说明填写（如 Read 的 file_path 必须是绝对路径）
- 工具返回错误时不要重复调用相同入参，先分析错误原因再调整

# 当前环境
- 工作目录：${process.cwd()}
- 操作系统：${process.platform}
- 运行时：Bun ${Bun.version}`

  const toolSection = opts?.tools && opts.tools.length > 0
    ? `\n\n# 可用工具\n\n${opts.tools
        .map((t) => `## ${t.name}\n\n${t.prompt}`)
        .join('\n\n')}`
    : ''

  return base + toolSection
}
