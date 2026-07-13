// src/cli.tsx
// CLI 参数解析入口。M1 只支持交互式 REPL；print-and-exit 模式留 M2。
import { Command } from '@commander-js/extra-typings'
import { VERSION, NAME } from '@/version.js'

const program = new Command()
  .name(NAME)
  .description('原生中文交互的终端 AI 编码工具')
  .version(VERSION)
  .argument('[prompt]', '可选的一次性提示（M1 暂不支持，留 M2）')
  .option('-v, --verbose', '启用详细日志输出', false)
  .action(async (prompt, opts) => {
    // M1: 无论参数如何，都进 REPL
    // M2 会在这里分流：有 prompt → 一次性模式；无 prompt → REPL
    if (prompt) {
      console.error(`[M1] 一次性模式将在 M2 支持，本次忽略提示，进入交互模式。`)
    }
    // 动态 import：避免顶层依赖未实现的模块（@/repl/App.js 要到 Task 9 才创建），
    // 让 Task 5 阶段 typecheck 能通过。Task 9 实现 App 后可改回静态 import。
    // 注：直接写字面量 '@/repl/App.js' 会被 tsc 模块解析器抓到 TS2307，
    // 因此用动态拼路径绕过（module: 'ESNext' + dynamic import 在运行时由 Bun 解析）。
    const replModule = './repl/App.js'
    const { startRepl } = await import(replModule)
    await startRepl({ verbose: opts.verbose })
  })

// 仅当此文件是主入口时解析参数（避免被 import 时副作用执行）
const isMain = typeof Bun !== 'undefined' && process.argv[1]?.endsWith('cli.tsx')
if (isMain) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error(`\n${NAME} 启动失败:`, err)
    process.exit(1)
  })
}

export { program }
