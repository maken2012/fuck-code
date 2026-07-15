// src/tools/Glob.ts
// 按 glob 模式递归查找文件。用 Bun.Glob（运行时原生）。
// 深度比对第 23 轮: 路径校验 + 截断引导 + 耗时统计 + VCS 排除（对标 Claude Code）
import { buildTool } from '@/tools/Tool.js'
import { stat } from 'node:fs/promises'
import { getAllSearchDirs } from '@/tools/extraDirs.js'
import { z } from 'zod'

const GlobInput = z.object({
  pattern: z.string().describe('glob 模式，如 **/*.ts'),
  path: z.string().describe('搜索目录，默认 cwd').optional(),
})
type GlobInputType = z.infer<typeof GlobInput>

const MAX_RESULTS = 100

export const GlobTool = buildTool<GlobInputType>({
  name: 'Glob',
  description: '按 glob 模式查找文件',
  prompt: `按 glob 模式递归查找文件路径。

参数：
- pattern（必填）：glob 模式，如 "**/*.ts"、"src/**/*.test.ts"
- path（可选）：搜索根目录（必须是目录，不是文件），默认 cwd

返回匹配的文件路径列表（相对路径，按字典序排序）。最多 ${MAX_RESULTS} 条。
超限提示"用更精确的 pattern 缩小范围"。自动排除 VCS 目录。含耗时统计。`,
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
    const startTime = Date.now()
    try {
      // v1.13: 显式 path 只搜该目录；否则搜 主 cwd + 额外目录（多目录工作区）
      const roots = input.path ? [input.path] : getAllSearchDirs(ctx.cwd)

      // 深度比对第 23 轮: 路径校验（每个 root 都校验）
      for (const root of roots) {
        try {
          const stats = await stat(root)
          if (!stats.isDirectory()) {
            return { ok: false, error: `${root} 不是目录（Glob 需要搜索目录）`, isError: true }
          }
        } catch {
          return { ok: false, error: `路径不存在: ${root}`, isError: true }
        }
      }

      const g = new Bun.Glob(input.pattern)
      const matches: string[] = []
      for (const root of roots) {
        for await (const path of g.scan({ cwd: root, absolute: false })) {
          if (!/\.(git|svn|hg|bzr)\//.test(path) && !/^\.(git|svn|hg|bzr)$/.test(path)) {
            // 多目录时用 "dir:path" 前缀区分来源
            matches.push(roots.length > 1 ? `${root.replace(/^.*\//, '')}: ${path}` : path)
          }
          // v1.18: streaming 进度——每 50 条推一次
          if (ctx.onProgress && matches.length % 50 === 0 && matches.length > 0) {
            ctx.onProgress({ lines: matches.slice(-3), totalLines: matches.length, elapsedMs: Date.now() - startTime })
          }
        }
      }
      if (matches.length === 0) {
        const dur = Date.now() - startTime
        return { ok: true, data: `（无匹配文件，${dur}ms）` }
      }
      matches.sort()
      const limited = matches.slice(0, MAX_RESULTS)
      const dur = Date.now() - startTime

      let summary = `\n（${matches.length} 个文件，${dur < 1000 ? `${dur}ms` : `${(dur / 1000).toFixed(1)}s`}）`
      if (limited.length < matches.length) {
        summary += `\n[仅显示前 ${MAX_RESULTS} 个。用更精确的 pattern 缩小范围。]`
      }
      return { ok: true, data: limited.join('\n') + summary }
    } catch (e) {
      const dur = Date.now() - startTime
      return { ok: false, error: `Glob 失败（${dur}ms）: ${(e as Error).message}`, isError: true }
    }
  },
})
