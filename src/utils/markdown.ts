// src/utils/markdown.ts
// Markdown 渲染——把模型回复的 markdown 转成带格式的终端文本。
// 用 marked lexer 解析 token，逐类用 ANSI 颜色/bold/dimColor 渲染。
// 代码块用 cli-highlight 做语法高亮。
//
// v1.19: 渲染增强（对标 Claude Code）：
// - 行内代码 → 反色背景块（黑底 cyan，终端里最醒目）
// - 链接 → OSC 8 可点击超链接 + 蓝色下划线（支持的终端可直接点开）
// - file_path:line_number → 自动识别成青色引用（模型常用代码定位）
// - bold → 黄色加粗（重点内容突出）
// - 代码块 → 语言标签底色 + 行号
import { marked } from 'marked'
import { highlight } from 'cli-highlight'

// marked 配置（不需要 GFM headingIds 等）
marked.setOptions({
  gfm: true,
  breaks: false,
})

// 宽松 token 类型（marked v16 类型导出变动）
type AnyToken = Record<string, unknown> & { type: string; raw?: string; text?: string; tokens?: AnyToken[]; lang?: string; depth?: number; items?: AnyToken[]; ordered?: boolean; start?: number; href?: string; align?: string[]; header?: AnyToken; rows?: AnyToken[] }

// === ANSI 颜色辅助 ===
const RESET = '\x1b[0m'
const bold = (s: string) => `\x1b[1m${s}${RESET}`
const dim = (s: string) => `\x1b[2m${s}${RESET}`
const cyan = (s: string) => `\x1b[36m${s}${RESET}`
const yellow = (s: string) => `\x1b[33m${s}${RESET}`
const blue = (s: string) => `\x1b[34m${s}${RESET}`
const green = (s: string) => `\x1b[32m${s}${RESET}`
const red = (s: string) => `\x1b[31m${s}${RESET}`
// 行内代码：黑底 cyan（反色块，终端最醒目）
const codeBg = (s: string) => `\x1b[30m\x1b[46m ${s} ${RESET}`
// bold 重点：黄色加粗
const emphasis = (s: string) => `\x1b[1m\x1b[33m${s}${RESET}`

// OSC 8 可点击超链接（支持的终端如 iTerm2/WezTerm/Ghostty 可直接 Cmd+Click 打开）
const oscLink = (text: string, url: string) => {
  const show = text || url
  return `\x1b]8;;${url}\x1b\\${blue('\x1b[4m' + show + RESET)}\x1b]8;;\x1b\\`
}

/**
 * 把 markdown 文本渲染成带 ANSI 颜色的终端文本。
 * 返回纯字符串（已含 ANSI 转义码），可直接喂给 Ink <Text>。
 */
export function renderMarkdown(text: string): string {
  const tokens = marked.lexer(text) as AnyToken[]
  const parts: string[] = []

  for (const token of tokens) {
    parts.push(renderToken(token))
  }

  return parts.join('\n').trim()
}

function renderToken(token: AnyToken): string {
  switch (token.type) {
    case 'heading': {
      const level = token.depth ?? 1
      const text = inlineText(token)
      if (level <= 2) return `\x1b[1m\x1b[36m${text}${RESET}`  // bold cyan
      if (level === 3) return `\x1b[1m\x1b[33m${text}${RESET}`  // bold yellow
      return `\x1b[1m${text}${RESET}`  // bold
    }

    case 'code': {
      const lang = token.lang ?? ''
      let code: string = token.text ?? ''
      // 语法高亮
      if (lang) {
        try {
          code = highlight(code, { language: lang })
        } catch {
          // 不支持的语言保持原样
        }
      }
      // v1.19: 语言标签底色 + 行号
      const lines = code.split('\n')
      const padWidth = String(lines.length).length
      const numbered = lines.map((l: string, i: number) => {
        const num = String(i + 1).padStart(padWidth, ' ')
        // 行号 dim，代码原样（已含高亮 ANSI）
        return `  ${dim(num)} ${l}`
      }).join('\n')
      const label = lang ? `\x1b[30m\x1b[44m ${lang} ${RESET}` : dim(' code ')
      return `${label}\n${numbered}`
    }

    case 'list': {
      const items = token.items ?? []
      const rendered = items.map((item: AnyToken, i: number) => {
        const prefix = token.ordered ? `${(token.start ?? 1) + i}. ` : '• '
        const text = inlineText(item)
        return `  ${cyan(prefix)}${text}`
      })
      return rendered.join('\n')
    }

    case 'blockquote': {
      const text = token.text ?? ''
      const lines = text.split('\n')
      return lines.map((l: string) => `  ${dim('│ ')}${dim(l)}`).join('\n')
    }

    case 'hr':
      return dim('─'.repeat(48))

    case 'paragraph':
      return inlineText(token)

    case 'table': {
      // v1.19: 简易表格渲染（对齐列宽）
      return renderTable(token)
    }

    case 'space':
      return ''

    default:
      return token.raw ?? ''
  }
}

// v1.19: 表格渲染——计算列宽，对齐显示
function renderTable(token: AnyToken): string {
  const headerTok = token.header
  const rows = token.rows ?? []
  if (!headerTok) return token.raw ?? token.text ?? ''

  const headers = (headerTok.tokens ?? []).map((t: AnyToken) => inlineText(t))
  const allRows: string[][] = [
    headers,
    ...rows.map((r: AnyToken) => {
      const cells = (r.tokens ?? []) as unknown as AnyToken[]
      return cells.map((t: AnyToken) => inlineText(t))
    }),
  ]
  // 移除 ANSI 计算真实宽度
  const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;]*m/g, '')
  const colCount = headers.length
  const widths: number[] = []
  for (let c = 0; c < colCount; c++) {
    widths[c] = Math.max(...allRows.map((row) => stripAnsi(String(row[c] ?? '')).length))
  }
  const padRow = (row: string[], isHeader = false) =>
    row.map((cell, c) => {
      const plain = stripAnsi(String(cell))
      const padLen = Math.max(0, (widths[c] ?? 0) - plain.length)
      return isHeader ? bold(String(cell)) + ' '.repeat(padLen) : String(cell) + ' '.repeat(padLen)
    }).join('  ')

  const sep = widths.map((w) => '─'.repeat(w)).join('──')
  return [padRow(headers, true), dim(sep), ...allRows.slice(1).map((r) => padRow(r))].join('\n')
}

// 渲染 inline token（bold/italic/code/link/text 混合）
function inlineText(token: AnyToken): string {
  if (!token.tokens || !Array.isArray(token.tokens)) {
    // 没有 token 子树时，对纯文本做 file:line 引用识别
    return highlightFileRefs(token.text ?? token.raw ?? '')
  }
  const parts: string[] = []
  for (const t of token.tokens) {
    switch (t.type) {
      case 'strong':
        // v1.19: bold 重点用黄色加粗突出
        parts.push(emphasis(t.text ?? ''))
        break
      case 'em':
        parts.push(`\x1b[3m${t.text ?? ''}${RESET}`)
        break
      case 'codespan':
        // v1.19: 行内代码用反色背景块
        parts.push(codeBg(t.text ?? ''))
        break
      case 'link': {
        // v1.19: OSC 8 可点击链接 + 蓝色下划线
        const linkText = (t.text ?? t.href ?? '') as string
        const linkUrl = (t.href ?? t.text ?? '') as string
        parts.push(oscLink(linkText, linkUrl))
        break
      }
      case 'text':
        // v1.19: 纯文本里也识别 file:line 引用
        parts.push(highlightFileRefs(t.text ?? t.raw ?? ''))
        break
      default:
        parts.push(t.raw ?? t.text ?? '')
    }
  }
  return parts.join('')
}

// v1.19: 识别 file_path:line_number 格式，渲染成青色引用（模型常用代码定位）
// 匹配：path/to/file.ts:123 或 /abs/path.py:42 或 file.go:8
function highlightFileRefs(text: string): string {
  // 路径字符 + :数字。避免误匹配时间(12:30)和 url(http://)
  return text.replace(/([\w./@-]+(?:\.[a-z]{1,6})+):(\d+)/g, (_m, path: string, line: string) => {
    return `\x1b[36m\x1b[4m${path}${RESET}\x1b[36m:${line}${RESET}`
  })
}
