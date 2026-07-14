// src/cli.tsx
// CLI 参数解析入口。有 prompt → 一次性模式（runOnce）；无 prompt → 交互 REPL。
import { Command } from '@commander-js/extra-typings'
import { VERSION, NAME } from '@/version.js'
import { startRepl } from '@/repl/App.js'
import { runOnce } from '@/agent/runOnce.js'

const program = new Command()
  .name(NAME)
  .description('原生中文交互的终端 AI 编码工具')
  .version(VERSION)
  .argument('[prompt]', '一次性提示：传了就走非交互模式，不传进 REPL')
  .option('-v, --verbose', '启用详细日志输出', false)
  .option('-m, --model <model>', '覆盖 config.json 的 model（如 claude-sonnet-4-5-20250929）')
  .option('--api-key <key>', '覆盖 config.json 的 apiKey（建议用环境变量）')
  .option('--api-base-url <url>', '覆盖 config.json 的 apiBaseUrl（第三方兼容中转）')
  .option('--plan', '只读分析模式（不修改任何文件，适合需求分析/代码审查）')
  .option('--safe-mode', '安全模式：禁用所有定制（AGENTS.md/memory/hooks/MCP/自定义命令/动态工具），排查问题用')
  .action(async (prompt, opts) => {
    const safeMode = opts.safeMode ?? false
    if (safeMode) {
      process.stderr.write('\x1b[33m⚠ 安全模式：已禁用 AGENTS.md / 记忆 / hooks / MCP / 自定义命令 / 动态工具\x1b[0m\n')
      // 用环境变量通知各模块跳过加载
      process.env.FUCKCODE_SAFE_MODE = '1'
    }
    const common = {
      modelOverride: opts.model,
      apiKeyOverride: opts.apiKey,
      apiBaseUrlOverride: opts.apiBaseUrl,
    }

    // 有 prompt → 一次性模式
    if (prompt) {
      // 读 stdin（如果是管道）
      let stdin: string | undefined
      if (!process.stdin.isTTY) {
        try {
          const chunks: Buffer[] = []
          for await (const chunk of process.stdin) {
            chunks.push(chunk as Buffer)
          }
          stdin = Buffer.concat(chunks).toString('utf8').trim() || undefined
        } catch {
          // stdin 读失败不阻塞
        }
      }
      await runOnce({
        prompt,
        stdin,
        ...common,
        permissionMode: opts.plan ? 'plan' : undefined,
      })
      return
    }

    // 无 prompt → 交互 REPL
    await startRepl({ verbose: opts.verbose, ...common })
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
