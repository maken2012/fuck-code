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

      // 深度比对修复 #1：设备文件防护（防 /dev/zero 等导致 hang）
      const BLOCKED_DEVICES = ['/dev/zero', '/dev/random', '/dev/urandom', '/dev/null', '/dev/stdin', '/dev/full']
      if (BLOCKED_DEVICES.some((d) => input.file_path.startsWith(d))) {
        return { ok: false, error: `拒绝读取设备文件 ${input.file_path}（会导致 hang）`, isError: true }
      }

      // 大文件字节上限（256KB，防 minified/base64 爆 context）
      const MAX_BYTES = 256 * 1024
      if (stats.size > MAX_BYTES) {
        return {
          ok: false,
          error: `文件 ${stats.size} 字节超限（max ${MAX_BYTES}）。用 offset/limit 只读部分，或用 Grep 搜索关键内容。`,
          isError: true,
        }
      }

      const buf = await readFile(input.file_path)
      const content = buf.toString('utf8')

      // 二进制检测：扫前 8192 字节，NUL 字节或非打印字符 >30% 判定二进制
      const sampleSize = Math.min(buf.length, 8192)
      let nonPrintable = 0
      for (let i = 0; i < sampleSize; i++) {
        const byte = buf[i]!
        if (byte === 0) { nonPrintable = sampleSize + 1; break } // NUL 字节立即判定
        if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) nonPrintable++
      }
      if (nonPrintable > sampleSize * 0.3) {
        return {
          ok: false,
          error: `${input.file_path} 是二进制文件（${stats.size} 字节），不支持文本读取。`,
          isError: true,
        }
      }

      const lines = content.split('\n')
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
