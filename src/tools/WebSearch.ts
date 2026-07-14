// src/tools/WebSearch.ts
// Web 搜索工具。用 Anthropic 的 server-side web search（最简实现，无需额外 API key）。
// 实现方式：把这个工具标记为 Anthropic 内置的 web_search，让 API 自己处理。
// 模型调用时返回结构化结果。
//
// 注意：Anthropic 的 web_search 是 server_tool，不是普通 tool。
// 这里我们做一个客户端版本：用 fetch 调一个搜索接口（duckduckgo lite 或类似）。
// 为避免依赖第三方搜索 API，M1 版先返回引导信息，真正搜索在 v1.2 接 server-side。
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'

const WebSearchInput = z.object({
  query: z.string().describe('搜索关键词'),
  max_results: z.number().int().positive().max(10).optional().describe('最大结果数（默认 5）'),
})
type WebSearchInputType = z.infer<typeof WebSearchInput>

export const WebSearchTool = buildTool<WebSearchInputType>({
  name: 'WebSearch',
  description: '搜索网络（查文档、查最新 API、查 issue）',
  prompt: `搜索网络获取信息。用于：
- 查库/框架的官方文档
- 查最新的 API 变化（避免用过时信息）
- 查报错信息的解决方案
- 查 GitHub issue / Stack Overflow

参数：
- query（必填）：搜索关键词，用英文效果更好
- max_results（可选）：最大结果数，默认 5

返回搜索结果的标题 + URL + 摘要。找到有用内容后可以用 WebFetch 抓取完整页面。

注意：本地代码相关的问题（文件内容、项目结构）不要用 WebSearch，用 Grep/Glob/Read。`,
  inputSchema: WebSearchInput,
  jsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      max_results: { type: 'integer', minimum: 1, maximum: 10 },
    },
    required: ['query'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async execute(input) {
    const maxResults = input.max_results ?? 5
    // 用 DuckDuckGo Lite HTML 接口（无需 API key）
    try {
      const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(input.query)}`
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'fuckcode/1.0' },
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) {
        return { ok: false, error: `搜索请求失败: HTTP ${resp.status}`, isError: true }
      }
      const html = await resp.text()
      // DuckDuckGo Lite 的结果在 <a class="result-link" href="...">标题</a>
      const results: { title: string; url: string; snippet: string }[] = []
      const seenUrls = new Set<string>() // 深度比对第 42 轮: 结果去重
      const linkRegex = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g
      const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g
      const links = [...html.matchAll(linkRegex)]
      const snippets = [...html.matchAll(snippetRegex)]
      for (let i = 0; i < Math.min(links.length, maxResults * 2); i++) {
        const linkMatch = links[i]
        if (!linkMatch) continue
        const title = (linkMatch[2] ?? '').replace(/<[^>]+>/g, '').trim()
        const linkUrl = (linkMatch[1] ?? '').replace(/&amp;/g, '&')
        const snippet = (snippets[i]?.[1] ?? '').replace(/<[^>]+>/g, '').trim()
        if (!title || !linkUrl) continue
        // 深度比对第 42 轮: URL 去重（DuckDuckGo 有时返回重复结果）
        const urlKey = linkUrl.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase()
        if (seenUrls.has(urlKey)) continue
        seenUrls.add(urlKey)
        results.push({ title, url: linkUrl, snippet })
        if (results.length >= maxResults) break
      }
      if (results.length === 0) {
        return { ok: true, data: `搜索 "${input.query}" 无结果。可尝试换关键词或用 WebFetch 直接抓已知 URL。` }
      }
      // 深度比对第 42 轮: 结构化输出 + Sources 段（对标 Claude WebSearchTool 要求）
      const formatted = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.slice(0, 200)}`)
        .join('\n\n')
      const sources = results.map((r, i) => `[${i + 1}] ${r.url}`).join('\n')
      return { ok: true, data: `搜索 "${input.query}" 的结果：\n\n${formatted}\n\n---\nSources:\n${sources}` }
    } catch (e) {
      return { ok: false, error: `搜索失败（网络问题或被限流）: ${(e as Error).message}`, isError: true }
    }
  },
})
