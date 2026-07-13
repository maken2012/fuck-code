// tests/repl/Repl.test.tsx
//
// ink 7 把 lastFrame() 从主 'ink' 包里拆出去了（移到独立的 ink-testing-library 包），
// 我们没装那个包。这里用 mock stdin/stdout + ANSI 剥离来取渲染输出，
// 等价于 lastFrame() 的语义：返回最近一次写入的整帧。
//
// 关键点：
// 1. useInput() 在 mount 时调 stdin.setRawMode(true)；stdin.isTTY=false 会抛
//    "Raw mode is not supported"，ink 渲染出 error boundary 而非我们的组件。
//    所以 stdin mock 要 isTTY=true + setRawMode 空实现。
// 2. ink 在 unmount 时会写两次 stdout：先写最终帧（非交互模式下 deferred flush），
//    再写空串作为 flush barrier（ink.js:588）。所以取"最后一个非空写入"。
import { test, expect } from 'bun:test'
import React from 'react'
import { render } from 'ink'
import { Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { Repl } from '@/repl/Repl.js'

// 剥离 ANSI 转义序列（颜色 / 光标 / 清屏等），便于断言纯文本。
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
}

// mock stdin：必须支持 setRawMode / isRawModeSupported（ink 用 stdin.isTTY 判定），
// 否则 useInput 会抛 "Raw mode is not supported"。
function createFakeStdin() {
  const ee = new EventEmitter() as EventEmitter & {
    setRawMode: () => void
    setEncoding: () => void
    ref: () => void
    unref: () => void
    isTTY: boolean
    isRaw: boolean
  }
  ee.setRawMode = () => {}
  ee.setEncoding = () => {}
  ee.ref = () => {}
  ee.unref = () => {}
  ee.isTTY = true
  ee.isRaw = false
  return ee as unknown as NodeJS.ReadStream
}

// mock stdout：累积所有写入，lastFrame() 返回最后一个非空写入。
function createFakeStdout() {
  let last = ''
  const stream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      const text = chunk.toString()
      if (text !== '') last = text
      cb()
    },
    decodeStrings: false,
  })
  // 非交互模式（isTTY=false）下 ink 在 unmount 时 flush 最终帧。
  Object.defineProperties(stream, {
    columns: { value: 80, configurable: true },
    rows: { value: 24, configurable: true },
    isTTY: { value: false, configurable: true },
  })
  return {
    stream,
    lastFrame: () => stripAnsi(last),
  }
}

function renderWithFrame(node: React.ReactNode) {
  const stdout = createFakeStdout()
  const stdin = createFakeStdin()
  const instance = render(node, {
    stdout: stdout.stream as unknown as NodeJS.WriteStream,
    stdin,
  })
  return {
    lastFrame: () => stdout.lastFrame(),
    unmount: () => instance.unmount(),
  }
}

test('Repl 渲染欢迎语和输入框', () => {
  const { lastFrame, unmount } = renderWithFrame(
    <Repl version="0.1.0-test" modelName="claude-sonnet-4-5" />,
  )
  unmount()
  const frame = lastFrame() ?? ''
  expect(frame).toContain('fuckcode')
  expect(frame).toContain('0.1.0-test')
  expect(frame).toContain('claude-sonnet-4-5')
  expect(frame).toMatch(/输入|>|(❯)/) // 输入框提示符
})

test('Repl 显示快捷键提示', () => {
  const { lastFrame, unmount } = renderWithFrame(
    <Repl version="0.1.0" modelName="m" />,
  )
  unmount()
  const frame = lastFrame() ?? ''
  expect(frame).toContain('Ctrl+C') // 提示快捷键
})
