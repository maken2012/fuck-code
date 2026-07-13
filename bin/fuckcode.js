#!/usr/bin/env bun
// bin/fuckcode.js — fuckcode CLI 入口
// 薄封装：转发到真正的 TS 入口 src/cli.tsx
// 用 Bun shebang，因为整个项目依赖 Bun 运行时（package.json engines.bun）

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cliEntry = resolve(__dirname, '..', 'src', 'cli.tsx')

// 动态 import 让 Bun 即时编译 .tsx
await import(cliEntry)
