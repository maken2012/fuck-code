// src/tools/Glob.ts
// 按 glob 模式递归查找文件。用 Bun.Glob（运行时原生，已验证 1.3.14 的 .scan() 可用）。
// 返回相对路径列表，按字典序排序，最多 100 条。只读 + 可并发。
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'

const GlobInput = z.object({
  pattern: z.string().describe('glob 模式，如 **/*.ts'),
  path: z.string().describe('搜索目录，默认 cwd').optional(),
})
type GlobInputType = z.infer<typeof GlobInput>

// 单次返回上限（防止巨型仓库刷屏）
const MAX_RESULTS = 100

export const GlobTool = buildTool<GlobInputType>({
  name: 'Glob',
  description: '按 glob 模式查找文件',
  prompt: `按 glob 模式递归查找文件路径（用 Bun.Glob 运行时原生实现）。

参数：
- pattern（必填）：glob 模式，如 "**/*.ts"、"src/**/*.test.ts"
- path（可选）：搜索根目录，默认当前工作目录

返回匹配的文件路径列表（相对路径，按字典序排序）。最多返回 ${MAX_RESULTS} 条。`,
  inputSchema: GlobInput,
  jsonSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式' },
      path: { type: 'string', description: '搜索目录（默认 cwd）' },
    },
    required: ['pattern'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async execute(input, ctx) {
    try {
      const g = new Bun.Glob(input.pattern)
      const root = input.path ?? ctx.cwd
      const matches: string[] = []
      for await (const path of g.scan({ cwd: root, absolute: false })) {
        matches.push(path)
      }
      if (matches.length === 0) {
        return { ok: true, data: '（无匹配文件）' }
      }
      matches.sort()
      const limited = matches.slice(0, MAX_RESULTS)
      const summary =
        limited.length < matches.length ? `\n（共 ${matches.length} 个，显示前 ${MAX_RESULTS}）` : ''
      return { ok: true, data: limited.join('\n') + summary }
    } catch (e) {
      return { ok: false, error: `Glob 失败: ${(e as Error).message}`, isError: true }
    }
  },
})
