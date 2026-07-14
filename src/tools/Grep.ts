// src/tools/Grep.ts
// 用 ripgrep（rg）搜索文件内容。本机已装 rg（验证过 13.0.0）。
// 退出码：0=有匹配，1=无匹配（正常），其他=错误。
// 返回 file:line:content 格式。只读 + 可并发。
import { spawn } from 'node:child_process'
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'

const GrepInput = z.object({
  pattern: z.string().describe('正则表达式或搜索词'),
  path: z.string().describe('搜索目录，默认 cwd').optional(),
  glob: z.string().describe('文件类型过滤，如 *.ts').optional(),
  ignore_case: z.boolean().describe('忽略大小写').optional(),
})
type GrepInputType = z.infer<typeof GrepInput>

export const GrepTool = buildTool<GrepInputType>({
  name: 'Grep',
  description: '搜索文件内容（ripgrep）',
  prompt: `用 ripgrep（rg）搜索文件内容，返回匹配的行（带文件名和行号）。

参数：
- pattern（必填）：搜索词或正则表达式
- path（可选）：搜索目录，默认 cwd
- glob（可选）：文件过滤，如 "*.ts"
- ignore_case（可选）：忽略大小写

返回格式：file:line:content。无匹配时返回"（无匹配）"。`,
  inputSchema: GrepInput,
  jsonSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式或搜索词' },
      path: { type: 'string', description: '搜索目录（默认 cwd）' },
      glob: { type: 'string', description: '文件过滤，如 *.ts' },
      ignore_case: { type: 'boolean', description: '忽略大小写' },
    },
    required: ['pattern'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async execute(input, ctx) {
    return new Promise((resolve) => {
      const args = ['--line-number', '--no-heading', '--color=never']
      if (input.ignore_case) args.push('-i')
      if (input.glob) args.push('-g', input.glob)
      // pattern 以 - 开头时加 -e 防止 rg 当 option 解析
      if (input.pattern.startsWith('-')) args.push('-e', input.pattern)
      else args.push(input.pattern)
      args.push(input.path ?? ctx.cwd)

      const proc = spawn('rg', args, { cwd: ctx.cwd })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (d) => {
        stdout += d.toString()
      })
      proc.stderr.on('data', (d) => {
        stderr += d.toString()
      })
      proc.on('error', (e) => {
        resolve({
          ok: false,
          error: `rg 启动失败（可能未装 ripgrep）: ${e.message}`,
          isError: true,
        })
      })
      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ ok: true, data: stdout.trim() || '（无匹配）' })
        } else if (code === 1) {
          // rg 退出码 1 = 无匹配（正常情况）
          resolve({ ok: true, data: '（无匹配）' })
        } else {
          resolve({ ok: false, error: stderr.trim() || `rg 退出码 ${code}`, isError: true })
        }
      })
    })
  },
})
