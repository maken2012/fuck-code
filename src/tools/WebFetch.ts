// src/tools/WebFetch.ts
// 抓取 URL 内容并转成文本。照搬 Claude Code 的 WebFetch 思路（简化）：
// 抓 HTML → 去标签转文本 → 截断。不用小模型二次提取（那是 Claude Code 的优化，v1.2 再加）。
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'

const WebFetchInput = z.object({
  url: z.string().describe('要抓取的 URL（含 http:// 或 https://）'),
  max_length: z.number().int().positive().max(50000).optional().describe('返回文本最大字符数（默认 10000）'),
})
type WebFetchInputType = z.infer<typeof WebFetchInput>

// 极简 HTML → 文本：去 script/style/标签 + 解码常见实体
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

// SSRF 防护：拒绝内网地址（深度比对第 19 轮增强）
function isPrivateUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr)
    const host = u.hostname.toLowerCase()
    // 非 http/https 协议拒绝（file://, ftp://, gopher:// 等）
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true
    // localhost / 内网 IPv4
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return true
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
    // IPv6 本地地址
    if (host === '::1' || host === '[::1]' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true
    // 云元数据地址
    if (host === '169.254.169.254' || host === 'metadata.google.internal' || host === 'metadata') return true
    if (host === 'metadata.aws.internal' || host === '169.254.170.2') return true // AWS ECS
    // 本地域名
    if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return true
    return false
  } catch {
    return true
  }
}

export const WebFetchTool = buildTool<WebFetchInputType>({
  name: 'WebFetch',
  description: '抓取 URL 内容转成文本',
  prompt: `抓取一个 URL 的内容，转成纯文本返回。

参数：
- url（必填）：完整 URL（含 http:// 或 https://）
- max_length（可选）：返回文本最大字符数，默认 10000

安全限制（深度比对第 80 轮增强）：
- SSRF 全面防护（IPv4 内网 + IPv6 本地 + 云元数据 + 非 http 协议）
- 拒绝 file:// ftp:// gopher:// 等非 HTTP 协议
- 超时 15 秒
- 自动去 script/style/nav/footer，只留正文
- GitHub 文件建议用 raw.githubusercontent.com URL

用途：
- 读取文档页面（MDN/官方 docs）
- 读取 GitHub 文件/issue
- 读取 WebSearch 找到的页面
- 验证 API 返回内容

注意：本地代码相关的问题用 Read/Grep/Glob，不要用 WebFetch。`,
  inputSchema: WebFetchInput,
  jsonSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL' },
      max_length: { type: 'integer', minimum: 1, maximum: 50000 },
    },
    required: ['url'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async execute(input) {
    if (isPrivateUrl(input.url)) {
      return { ok: false, error: `拒绝抓取内网/本地地址（SSRF 防护）: ${input.url}`, isError: true }
    }
    const maxLength = input.max_length ?? 10000
    try {
      const resp = await fetch(input.url, {
        headers: { 'User-Agent': 'fuckcode/1.0' },
        signal: AbortSignal.timeout(15000),
        redirect: 'follow',
      })
      if (!resp.ok) {
        return { ok: false, error: `HTTP ${resp.status}: ${resp.statusText}`, isError: true }
      }
      const contentType = resp.headers.get('content-type') ?? ''
      const body = await resp.text()
      let text: string
      if (contentType.includes('text/html')) {
        text = htmlToText(body)
      } else {
        // JSON / 纯文本 / markdown 等直接用
        text = body
      }
      const truncated = text.length > maxLength
      const result = truncated ? text.slice(0, maxLength) + '\n\n...(已截断，共 ' + text.length + ' 字符)' : text
      return { ok: true, data: result }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('timeout') || msg.includes('abort')) {
        return { ok: false, error: '抓取超时（15 秒）', isError: true }
      }
      return { ok: false, error: `抓取失败: ${msg}`, isError: true }
    }
  },
})
