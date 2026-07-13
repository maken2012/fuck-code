// src/tools/Read.ts
// 读文件工具。输出 cat -n 风格（行号右对齐 6 宽 + tab + 内容），支持 offset/limit。
// 默认最多 2000 行。只读 + 可并发（不改文件系统）。
import { readFile, stat } from 'node:fs/promises'
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'

const ReadInput = z.object({
  file_path: z.string().describe('要读取的文件绝对路径'),
  offset: z.number().int().positive().describe('起始行号（1-based）').optional(),
  limit: z.number().int().positive().describe('读取行数（默认 2000）').optional(),
})
type ReadInputType = z.infer<typeof ReadInput>

// 默认读取上限（与 Claude Code Read 工具一致）
const DEFAULT_LIMIT = 2000

export const ReadTool = buildTool<ReadInputType>({
  name: 'Read',
  description: '读取文件内容',
  prompt: `读取文件内容，按行号格式输出（cat -n 风格：行号右对齐 6 宽 + tab + 内容）。

参数：
- file_path（必填）：文件绝对路径
- offset（可选）：起始行号，1-based
- limit（可选）：读取行数，默认 ${DEFAULT_LIMIT}

用途：查看源码、配置文件、日志等文本文件。默认读前 ${DEFAULT_LIMIT} 行。`,
  inputSchema: ReadInput,
  jsonSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '要读取的文件绝对路径' },
      offset: { type: 'integer', minimum: 1, description: '起始行号（1-based）' },
      limit: { type: 'integer', minimum: 1, description: `读取行数（默认 ${DEFAULT_LIMIT}）` },
    },
    required: ['file_path'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async execute(input, ctx) {
    try {
      const stats = await stat(input.file_path)
      if (!stats.isFile()) {
        return { ok: false, error: `${input.file_path} 不是文件（可能是目录）`, isError: true }
      }
      const content = await readFile(input.file_path, 'utf8')
      const lines = content.split('\n')
      // 文件以 \n 结尾时 split 产生末尾空串，去掉它（保留真正的空行）
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

      const offset = input.offset ?? 1
      const limit = input.limit ?? DEFAULT_LIMIT
      const start = Math.max(0, offset - 1)
      const end = Math.min(lines.length, start + limit)
      const slice = lines.slice(start, end)

      // cat -n 格式：行号右对齐 6 宽 + tab + 内容
      const numbered = slice
        .map((line, i) => `${String(start + i + 1).padStart(6, ' ')}\t${line}`)
        .join('\n')

      const totalLines = lines.length
      const shownRange = `${start + 1}-${end}`
      const summary = `\n（共 ${totalLines} 行，显示 ${shownRange}）`

      // M4：记录已读状态（mtime + readAt），供 Edit/Write 写前校验"已读且未被外部修改"
      ctx.readFileState.set(input.file_path, {
        mtime: stats.mtimeMs,
        readAt: Date.now(),
      })

      return { ok: true, data: numbered + summary }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        return { ok: false, error: `文件不存在: ${input.file_path}`, isError: true }
      }
      return { ok: false, error: `读取失败: ${err.message}`, isError: true }
    }
  },
})
