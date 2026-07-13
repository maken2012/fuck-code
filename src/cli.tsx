// src/cli.tsx
// CLI 参数解析入口。M1 只支持交互式 REPL；print-and-exit 模式留 M2。
import { Command } from '@commander-js/extra-typings'
import { VERSION, NAME } from '@/version.js'
import { startRepl } from '@/repl/App.js'

const program = new Command()
  .name(NAME)
  .description('原生中文交互的终端 AI 编码工具')
  .version(VERSION)
  .argument('[prompt]', '可选的一次性提示（v0.2 支持）')
  .option('-v, --verbose', '启用详细日志输出', false)
  .action(async (prompt, opts) => {
    // M1: 无论参数如何，都进 REPL
    // M2 会在这里分流：有 prompt → 一次性模式；无 prompt → REPL
    if (prompt) {
      console.error(`[M1] 一次性模式将在 M2 支持，本次忽略提示，进入交互模式。`)
    }
    await startRepl({ verbose: opts.verbose })
  })

// 解析 argv 并启动。供 bin 入口（bin/fuckcode.js）和直接运行（bun run src/cli.tsx）共用。
// 用显式 run() 而非 import.meta.main 守卫，因为 bin 通过动态 import 本文件时，
// import.meta.main 会是 false（主入口是 bin/fuckcode.js），导致 parse 永不触发。
export async function run(argv: string[] = process.argv): Promise<void> {
  await program.parseAsync(argv).catch((err: unknown) => {
    console.error(`\n${NAME} 启动失败:`, err)
    process.exit(1)
  })
}

// 当本文件被直接作为主入口运行（bun run src/cli.tsx）时自动启动。
// 被 import（如测试、bin 转发）时不触发，避免副作用。
if (typeof Bun !== 'undefined' && import.meta.main) {
  void run()
}

export { program }
