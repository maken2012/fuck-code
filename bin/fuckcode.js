#!/usr/bin/env bun
// bin/fuckcode.js — fuckcode CLI 入口
// 薄封装：转发到真正的 TS 入口 src/cli.tsx，显式调用 run() 启动 commander。
// 用 Bun shebang，因为整个项目依赖 Bun 运行时（package.json engines.bun）
//
// 注意：不能用 import.meta.main 守卫让 cli.tsx 自动 parse——
// 动态 import 时 cli.tsx 的 import.meta.main 是 false（主入口是本文件），
// 所以这里必须显式调用 run()。
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cliEntry = resolve(__dirname, '..', 'src', 'cli.tsx')

const { run } = await import(cliEntry)
await run(process.argv)
