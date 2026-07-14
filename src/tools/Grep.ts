// src/tools/Grep.ts
// 用 ripgrep（rg）搜索文件内容。
// 深度比对修复 #6：加 output_mode（files_with_matches / content / count）
// + head_limit 分页 + max-columns 防刷屏 + -e 保护 + VCS 目录排除
import { spawn } from 'node:child_process'
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'

const GrepInput = z.object({
  pattern: z.string().describe('正则表达式或搜索词'),
  path: z.string().describe('搜索目录，默认 cwd').optional(),
  glob: z.string().describe('文件类型过滤，如 *.ts').optional(),
  type: z.string().describe('按语言类型过滤（如 ts/js/py/go），比 glob 更高效').optional(),
  ignore_case: z.boolean().describe('忽略大小写').optional(),
  multiline: z.boolean().describe('多行匹配（跨行正则，对标 Claude Code -U --multiline-dotall）').optional(),
  output_mode: z.enum(['files_with_matches', 'content', 'count']).describe(
    '输出模式：files_with_matches=只返回文件名（默认，省 token）；content=返回匹配行；count=返回每文件匹配数'
  ).optional(),
  head_limit: z.number().int().positive().describe('最大返回条数（默认 200，设 0 为无限）').optional(),
})
type GrepInputType = z.infer<typeof GrepInput>

const DEFAULT_HEAD_LIMIT = 200
const MAX_COLUMNS = 500

export const GrepTool = buildTool<GrepInputType>({
  name: 'Grep',
  description: '搜索文件内容（ripgrep）',
  prompt: `用 ripgrep（rg）搜索文件内容。

参数：
- pattern（必填）：搜索词或正则表达式
- path（可选）：搜索目录，默认 cwd
- glob（可选）：文件过滤，如 "*.ts"
- ignore_case（可选）：忽略大小写
- output_mode（可选）：files_with_matches=只返回文件名（默认，省 token）；content=返回匹配行（file:line:content）；count=返回每文件匹配数
- head_limit（可选）：最大返回条数（默认 200）

默认只返回匹配的文件名列表（省 token）。需要看匹配内容时设 output_mode=content。`,
  inputSchema: GrepInput,
  jsonSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式或搜索词' },
      path: { type: 'string', description: '搜索目录（默认 cwd）' },
      glob: { type: 'string', description: '文件过滤，如 *.ts' },
      ignore_case: { type: 'boolean', description: '忽略大小写' },
      output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'], description: 'files_with_matches（默认）/ content / count' },
      head_limit: { type: 'integer', minimum: 0, description: '最大返回条数（默认 200）' },
      type: { type: 'string', description: '语言类型（ts/js/py/go 等，比 glob 高效）' },
    },
    required: ['pattern'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async execute(input, ctx) {
    const outputMode = input.output_mode ?? 'files_with_matches'
    const headLimit = input.head_limit ?? DEFAULT_HEAD_LIMIT

    return new Promise((resolve) => {
      const args = ['--no-heading', '--color=never', '--max-columns', String(MAX_COLUMNS)]
      // VCS 目录排除
      args.push('--glob', '!{.git,.svn,.hg,.bzr}')

      if (input.ignore_case) args.push('-i')
      if (input.glob) args.push('-g', input.glob)
      if (input.type) args.push('--type', input.type)
      // 深度比对第 66 轮: multiline 支持（对标 Claude Code GrepTool -U --multiline-dotall）
      if (input.multiline) { args.push('-U', '--multiline-dotall') }

      // output_mode 对应 rg 参数
      if (outputMode === 'files_with_matches') args.push('-l')
      else if (outputMode === 'count') args.push('-c')
      else args.push('--line-number') // content 模式

      // pattern 以 - 开头时加 -e 防止 rg 当 option 解析
      if (input.pattern.startsWith('-')) args.push('-e', input.pattern)
      else args.push(input.pattern)
      args.push(input.path ?? ctx.cwd)

      const proc = spawn('rg', args, { cwd: ctx.cwd })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (d) => { stdout += d.toString() })
      proc.stderr.on('data', (d) => { stderr += d.toString() })
      proc.on('error', (e) => {
        resolve({ ok: false, error: `rg 启动失败（可能未装 ripgrep）: ${e.message}`, isError: true })
      })
      proc.on('close', (code) => {
        if (code !== 0 && code !== 1) {
          resolve({ ok: false, error: stderr.trim() || `rg 退出码 ${code}`, isError: true })
          return
        }
        if (code === 1 || !stdout.trim()) {
          resolve({ ok: true, data: '（无匹配）' })
          return
        }

        // 分页截断
        let lines = stdout.trim().split('\n')
        let truncated = false
        const totalCount = lines.length
        if (headLimit > 0 && totalCount > headLimit) {
          lines = lines.slice(0, headLimit)
          truncated = true
        }

        // 路径相对化（省 token）
        const cwd = ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/'
        lines = lines.map((l) => l.replace(cwd, ''))

        let result = lines.join('\n')
        if (truncated) {
          result += `\n\n[显示前 ${headLimit} 条，共 ${totalCount} 条匹配。用更精确的 pattern 或 glob 缩小范围，或增大 head_limit。]`
        }

        // 结果摘要
        if (outputMode === 'files_with_matches') {
          const fileCount = lines.length
          resolve({ ok: true, data: `匹配 ${totalCount} 个文件${truncated ? `（显示前 ${headLimit}）` : ''}:\n${result}` })
        } else if (outputMode === 'count') {
          resolve({ ok: true, data: result })
        } else {
          resolve({ ok: true, data: result })
        }
      })
    })
  },
})
