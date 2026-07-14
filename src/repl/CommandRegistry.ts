// src/repl/CommandRegistry.ts
// 命令注册中心类。管理所有斜杠命令的注册、匹配、执行。
// 从 Repl 的 31 个 if-else 命令分发中抽出，遵循开闭原则（加命令不改分发逻辑）。

export interface CommandInfo {
  cmd: string
  desc: string
  args?: string
  example?: string
}

export type CommandHandler = (args: string) => Promise<void> | void

interface RegisteredCommand extends CommandInfo {
  aliases: string[]
  handler: CommandHandler
  requiresRunning?: boolean // 是否需要 running=false 才执行
}

/**
 * 命令注册中心。职责：
 * 1. 注册命令（含别名）
 * 2. 实时匹配（输入 / 后过滤）
 * 3. 执行（分发到 handler）
 */
export class CommandRegistry {
  private commands: RegisteredCommand[] = []

  /** 注册一个命令 */
  register(info: CommandInfo, handler: CommandHandler, options?: {
    aliases?: string[]
    requiresRunning?: boolean
  }): void {
    this.commands.push({
      ...info,
      aliases: options?.aliases ?? [],
      handler,
      requiresRunning: options?.requiresRunning ?? false,
    })
  }

  /** 获取所有命令（含描述，用于实时提示） */
  getAll(): CommandInfo[] {
    return this.commands.map(({ cmd, desc, args, example }) => ({ cmd, desc, args, example }))
  }

  /** 实时过滤匹配的命令（输入 / 开头时用） */
  match(input: string): CommandInfo[] {
    if (!input.startsWith('/')) return []
    return this.getAll().filter((c) => c.cmd.startsWith(input))
  }

  /** 尝试匹配并执行命令。匹配到返回 true，否则 false */
  async tryExecute(input: string, isRunning: boolean): Promise<boolean> {
    const trimmed = input.trim()
    if (!trimmed.startsWith('/')) return false

    // 提取命令名和参数（/workflow 需求 → cmd=/workflow, args=需求）
    const spaceIdx = trimmed.indexOf(' ')
    const cmdName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
    const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

    // 精确匹配或前缀匹配（命令名 + 空格）
    const match = this.commands.find(
      (c) => c.cmd === cmdName || c.aliases.includes(cmdName),
    )
    if (!match) return false

    if (match.requiresRunning && isRunning) return false

    await match.handler(args)
    return true
  }
}
