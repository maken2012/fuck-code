// src/tools/Write.ts
// 整文件重写。**必须先 Read**（readFileState 校验，hard guard）。
//
// 设计（照搬 Claude Code）：
// - readFileState 无记录 → 拒绝（防止模型盲改没看过的文件）
// - 原子写：写 `${path}.tmp.${pid}` 再 rename（避免半写状态）
// - 写完更新 readFileState（mtime + readAt），保证后续 Edit 不被误判"外部修改"
//
// isReadOnly: false（改文件系统），isConcurrencySafe: false（不可并发）。
import { writeFile, rename, stat } from 'node:fs/promises'
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'

const WriteInput = z.object({
  file_path: z.string().describe('要写入的文件绝对路径'),
  content: z.string().describe('完整文件内容（整文件覆盖）'),
})
type WriteInputType = z.infer<typeof WriteInput>

export const WriteTool = buildTool<WriteInputType>({
  name: 'Write',
  description: '整文件重写（必须先 Read）',
  prompt: `整文件重写（覆盖整个文件内容）。

参数：
- file_path（必填）：文件绝对路径
- content（必填）：完整的文件内容

**硬护栏**：调用前必须先用 Read 读取过该文件（readFileState 有记录），否则拒绝执行。
这是为了防止盲改没看过的文件。写完后会更新已读状态，方便后续 Edit。

写入采用原子操作（写临时文件再 rename），避免半写状态。`,
  inputSchema: WriteInput,
  jsonSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '要写入的文件绝对路径' },
      content: { type: 'string', description: '完整文件内容（整文件覆盖）' },
    },
    required: ['file_path', 'content'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  async execute(input, ctx) {
    const { file_path, content } = input
    // 深度比对第 11 轮: 大文件防护（1G 限制）
    const MAX_WRITE_BYTES = 1024 * 1024 * 1024
    if (content.length > MAX_WRITE_BYTES) {
      return {
        ok: false,
        error: `内容 ${content.length} 字节超限（max 1GB）。减少内容或分多次写入。`,
        isError: true,
      }
    }

    // 深度比对第 28 轮: 文件不存在时允许创建新文件（对标 Claude Code 空文件创建语义）
    let fileExists = true
    try {
      await stat(file_path)
    } catch {
      fileExists = false
    }

    // 硬护栏：已存在的文件必须先 Read（防止盲改）；新文件不需要
    if (fileExists) {
      const state = ctx.readFileState.get(file_path)
      if (!state) {
        return {
          ok: false,
          error: `必须先用 Read 读取该文件后才能 Write: ${file_path}`,
          isError: true,
        }
      }
    }

    try {
      // 深度比对第 28 轮: 自动创建父目录（对标 Claude Code mkdir -p 行为）
      const { mkdir } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      await mkdir(dirname(file_path), { recursive: true }).catch(() => {})

      // 写前 checkpoint 备份（仅文件已存在时）
      if (fileExists) {
        const { checkpoint } = await import('@/tools/checkpoint.js')
        await checkpoint(ctx.cwd, file_path).catch(() => {})
      }

      // 原子写：写 .tmp.${pid} 再 rename
      const tmpPath = `${file_path}.tmp.${process.pid}`
      await writeFile(tmpPath, content, 'utf8')
      await rename(tmpPath, file_path)

      // 更新 readFileState（用新的 mtime）
      const newStat = await stat(file_path)
      ctx.readFileState.set(file_path, {
        mtime: newStat.mtimeMs,
        readAt: Date.now(),
      })

      const action = fileExists ? '已写入' : '已创建'
      return {
        ok: true,
        data: `${action} ${file_path}（${content.length} 字节）`,
      }
    } catch (e) {
      return { ok: false, error: `写入失败: ${(e as Error).message}`, isError: true }
    }
  },
})
