// src/repl/App.tsx
// Ink render 入口。startRepl 是 cli.tsx 调用的对外函数。
import { render } from 'ink'
import React from 'react'
import { Repl } from '@/repl/Repl.js'
import { VERSION } from '@/version.js'
import { getRuntime, getConfig } from '@/services/runtime.js'

export interface StartReplOpts {
  verbose?: boolean
}

export async function startRepl(opts: StartReplOpts = {}): Promise<void> {
  // 启动期初始化 runtime（异步：ConfigLive 读文件是 Effect.tryPromise，
  // Layer.toRuntime 必须 runPromise 求值，见 runtime.ts 注释）。
  await getRuntime(opts)
  // 读一次 config 用于显示（如 model 名）；失败不阻塞启动。
  const config = await getConfig().catch(() => null)

  const instance = render(<Repl version={VERSION} modelName={config?.value.model} />, {
    exitOnCtrlC: false, // 我们自己处理 Ctrl+C
  })

  // 等待 Ink 实例结束（用户 /exit 时 Repl 调 exit()）
  await instance.waitUntilExit()
}
