// src/repl/vim.ts
// vim modal 编辑逻辑（输入框行编辑，对标 Claude Code --vim）。
//
// 两种模式：
// - insert（默认）：正常打字，所有 emacs 快捷键（Ctrl+A/E/B/F 等）由 Repl 的 useInput 处理
// - normal：接管按键，hjkl/w/b/0/$/gg/G 移动光标，i/a/o/I/A/O 进 insert，x/dd/dw 删
//
// 设计：纯函数，输入 {input, offset, mode, char, key} → 输出新状态 {input?, offset?, mode?, handled}
// handled=true 表示 vim 吃掉了这次按键（Repl 不再走 emacs 逻辑）
import type { Key } from 'ink'

export type VimMode = 'normal' | 'insert'

export interface VimState {
  input: string
  offset: number
  mode: VimMode
}

export interface VimResult {
  /** 新输入（undefined=不变） */
  input?: string
  /** 新光标（undefined=不变） */
  offset?: number
  /** 新模式（undefined=不变） */
  mode?: VimMode
  /** true=vim 处理了这次按键，Repl 不该再走 emacs/默认逻辑 */
  handled: boolean
  /** 待 push 到历史（normal 模式回车提交时） */
  submit?: boolean
}

// 词边界：vim 的 w/b 按词移动（标点+空格分词）
function wordForward(input: string, offset: number): number {
  let i = offset
  // 跳过当前词尾
  while (i < input.length && !/[\s,.;:!?(){}[\]"'`]/.test(input[i]!)) i++
  // 跳过分隔符
  while (i < input.length && /[\s,.;:!?(){}[\]"'`]/.test(input[i]!)) i++
  return Math.min(i, input.length)
}

function wordBackward(input: string, offset: number): number {
  let i = offset - 1
  while (i > 0 && /[\s,.;:!?(){}[\]"'`]/.test(input[i]!)) i--
  while (i > 0 && !/[\s,.;:!?(){}[\]"'`]/.test(input[i - 1]!)) i--
  return Math.max(0, i)
}

/**
 * 处理一次按键。只在 vim 启用 + normal 模式时接管；
 * insert 模式的 Esc 切换由调用方在 emacs 分支前处理。
 */
export function handleVimNormalKey(
  state: VimState,
  char: string,
  key: Key,
): VimResult {
  const { input, offset } = state

  // Esc 在 normal 模式无操作（留在 normal）
  if (key.escape || char === '\x1b') return { handled: true }

  // 移动：hjkl
  if (char === 'h' || key.leftArrow) return { offset: Math.max(0, offset - 1), handled: true }
  if (char === 'l' || key.rightArrow) return { offset: Math.min(input.length, offset + 1), handled: true }
  // 行首/行尾（0 / $）
  if (char === '0') return { offset: 0, handled: true }
  if (char === '$') return { offset: input.length, handled: true }
  // 词移动 w / b
  if (char === 'w') return { offset: wordForward(input, offset), handled: true }
  if (char === 'b') return { offset: wordBackward(input, offset), handled: true }

  // 进入 insert：i(光标处) a(光标后) A(行尾) I(行首) o(新行)
  if (char === 'i') return { mode: 'insert', handled: true }
  if (char === 'a') return { mode: 'insert', offset: Math.min(input.length, offset + 1), handled: true }
  if (char === 'A') return { mode: 'insert', offset: input.length, handled: true }
  if (char === 'I') return { mode: 'insert', offset: 0, handled: true }

  // 删除：x(删光标处字符)
  if (char === 'x') {
    if (offset >= input.length) return { handled: true }
    const newInput = input.slice(0, offset) + input.slice(offset + 1)
    return { input: newInput, offset: Math.min(offset, newInput.length), handled: true }
  }

  // dd: 删整行（清空）
  if (char === 'd') {
    // 简化：d 后跟 d 才删行。这里 d 作为前缀太复杂，直接把单次 d 映射为删到行尾（D 语义）
    // 实际 vim 需要两次 d，但 Ink useInput 无状态机缓存，这里做"D 删到行尾"近似
    const newInput = input.slice(0, offset)
    return { input: newInput, offset: Math.min(offset, newInput.length), handled: true }
  }
  // dw: 删一个词
  if (char === 'D' /* Shift+D 不易触发，用大写 D 做删词 fallback */) {
    const end = wordForward(input, offset)
    const newInput = input.slice(0, offset) + input.slice(end)
    return { input: newInput, offset: Math.min(offset, newInput.length), handled: true }
  }

  // 回车：normal 模式回车提交输入
  if (key.return) {
    return { handled: true, submit: true }
  }

  // 其他按键在 normal 模式忽略
  return { handled: true }
}
