// tests/repl/vim.test.ts
// vim modal 编辑逻辑测试
import { test, expect } from 'bun:test'
import type { Key } from 'ink'
import { handleVimNormalKey } from '@/repl/vim.js'

// 模拟 Ink 的 Key 对象（只需用到的字段，其余缺省 false）
const noKey = {
  escape: false, return: false, ctrl: false, meta: false, shift: false,
  tab: false, backspace: false, delete: false, leftArrow: false, rightArrow: false,
  upArrow: false, downArrow: false, pageUp: false, pageDown: false,
  home: false, end: false,
} as Key

test('normal 模式 hjkl 移动光标', () => {
  const state = { input: 'hello', offset: 2, mode: 'normal' as const }
  // h 左移
  expect(handleVimNormalKey(state, 'h', noKey).offset).toBe(1)
  // l 右移
  expect(handleVimNormalKey({ ...state, offset: 2 }, 'l', noKey).offset).toBe(3)
})

test('normal 模式 0 / $ 跳行首行尾', () => {
  const state = { input: 'hello', offset: 2, mode: 'normal' as const }
  expect(handleVimNormalKey(state, '0', noKey).offset).toBe(0)
  expect(handleVimNormalKey(state, '$', noKey).offset).toBe(5)
})

test('normal 模式 i/a 进 insert', () => {
  const state = { input: 'hello', offset: 2, mode: 'normal' as const }
  expect(handleVimNormalKey(state, 'i', noKey).mode).toBe('insert')
  // a 光标后进 insert
  const r = handleVimNormalKey(state, 'a', noKey)
  expect(r.mode).toBe('insert')
  expect(r.offset).toBe(3)
})

test('normal 模式 A 行尾进 insert', () => {
  const state = { input: 'hello', offset: 1, mode: 'normal' as const }
  const r = handleVimNormalKey(state, 'A', noKey)
  expect(r.mode).toBe('insert')
  expect(r.offset).toBe(5)
})

test('normal 模式 x 删光标处字符', () => {
  const state = { input: 'hello', offset: 1, mode: 'normal' as const }
  const r = handleVimNormalKey(state, 'x', noKey)
  expect(r.input).toBe('hllo')
  expect(r.offset).toBe(1)
})

test('normal 模式 x 在末尾不越界', () => {
  const state = { input: 'hi', offset: 2, mode: 'normal' as const }
  const r = handleVimNormalKey(state, 'x', noKey)
  expect(r.input).toBeUndefined() // 不变
  expect(r.handled).toBe(true)
})

test('normal 模式 w 词移动', () => {
  const state = { input: 'hello world foo', offset: 0, mode: 'normal' as const }
  const r = handleVimNormalKey(state, 'w', noKey)
  expect(r.offset).toBe(6) // 跳到 world
})

test('normal 模式回车提交', () => {
  const state = { input: 'hello', offset: 2, mode: 'normal' as const }
  const returnKey = { ...noKey, return: true } as Key
  const r = handleVimNormalKey(state, '\r', returnKey)
  expect(r.submit).toBe(true)
  expect(r.handled).toBe(true)
})

test('normal 模式未知键被吃掉(handled=true)', () => {
  const state = { input: 'hello', offset: 2, mode: 'normal' as const }
  const r = handleVimNormalKey(state, 'z', noKey)
  expect(r.handled).toBe(true)
  expect(r.input).toBeUndefined()
  expect(r.offset).toBeUndefined()
})
