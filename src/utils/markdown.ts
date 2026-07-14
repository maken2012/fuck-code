// src/utils/markdown.ts
// Markdown 渲染——把模型回复的 markdown 转成带格式的终端文本。
// 用 marked lexer 解析 token，逐类用 ANSI 颜色/bold/dimColor 渲染。
// 代码块用 cli-highlight 做语法高亮。
import { marked } from 'marked'
import { highlight } from 'cli-highlight'

// marked 配置（不需要 GFM headingIds 等）
marked.setOptions({
  gfm: true,
  breaks: false,
})

// 宽松 token 类型（marked v16 类型导出变动）
type AnyToken = Record<string, unknown> & { type: string; raw?: string; text?: string; tokens?: AnyToken[]; lang?: string; depth?: number; items?: AnyToken[]; ordered?: boolean; start?: number }

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
      if (level <= 2) return `\x1b[1m\x1b[36m${text}\x1b[0m`  // bold cyan
      if (level === 3) return `\x1b[1m\x1b[33m${text}\x1b[0m`  // bold yellow
      return `\x1b[1m${text}\x1b[0m`  // bold
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
      // 加边框效果（每行缩进 + dim）
      const lines = code.split('\n')
      const bordered = lines.map((l: string) => `  ${l}`).join('\n')
      return `\x1b[2m┌─ ${lang || 'code'} ─┐\x1b[0m\n${bordered}\n\x1b[2m└──────┘\x1b[0m`
    }

    case 'list': {
      const items = token.items ?? []
      const rendered = items.map((item: AnyToken, i: number) => {
        const prefix = token.ordered ? `${(token.start ?? 1) + i}. ` : '- '
        const text = inlineText(item)
        return `  \x1b[37m${prefix}\x1b[0m${text}`
      })
      return rendered.join('\n')
    }

    case 'blockquote': {
      const text = token.text ?? ''
      const lines = text.split('\n')
      return lines.map((l: string) => `  \x1b[2m│ ${l}\x1b[0m`).join('\n')
    }

    case 'hr':
      return '\x1b[2m' + '─'.repeat(40) + '\x1b[0m'

    case 'paragraph':
      return inlineText(token)

    case 'table':
      // 简化：直接显示原始 markdown 表格（终端表格太复杂）
      return token.raw ?? token.text ?? ''

    case 'space':
      return ''

    default:
      return token.raw ?? ''
  }
}

// 渲染 inline token（bold/italic/code/link/text 混合）
function inlineText(token: AnyToken): string {
  if (!token.tokens || !Array.isArray(token.tokens)) {
    return token.text ?? token.raw ?? ''
  }
  const parts: string[] = []
  for (const t of token.tokens) {
    switch (t.type) {
      case 'strong':
        parts.push(`\x1b[1m${t.text ?? ''}\x1b[0m`)
        break
      case 'em':
        parts.push(`\x1b[3m${t.text ?? ''}\x1b[0m`)
        break
      case 'codespan':
        parts.push(`\x1b[36m${t.text ?? ''}\x1b[0m`)
        break
      case 'link':
        parts.push(`\x1b[4m${t.text ?? t.href}\x1b[0m`)
        break
      case 'text':
        parts.push(t.text ?? t.raw ?? '')
        break
      default:
        parts.push(t.raw ?? t.text ?? '')
    }
  }
  return parts.join('')
}
