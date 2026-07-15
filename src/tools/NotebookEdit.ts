// src/tools/NotebookEdit.ts
// Jupyter Notebook 编辑工具（对标 Claude Code NotebookEdit）。
// .ipynb 本质是 JSON，无需外部依赖——直接 JSON.parse/stringify 操作 cells 数组。
//
// 支持三种编辑模式：
//   1. 替换 cell（给 cell_id + new_source）
//   2. 插入 cell（给 insertion_index，不传 cell_id）
//   3. 删除 cell（edit_mode=delete + cell_id）
//
// 两个硬护栏（同 Edit.ts）：
//   1. 必须先 Read 该 notebook（readFileState 有记录）
//   2. 文件未被外部修改（mtimeMs 一致）
// 原子写 + checkpoint 备份 + 写完更新 readFileState。
import { readFile, writeFile, rename, stat } from 'node:fs/promises'
import { buildTool } from '@/tools/Tool.js'
import { checkpoint } from '@/tools/checkpoint.js'
import { resolve } from 'node:path'
import { z } from 'zod'

const NotebookEditInput = z.object({
  notebook_path: z.string().describe('要编辑的 .ipynb 文件绝对路径'),
  cell_id: z.string().describe('要编辑的 cell ID（替换/删除时必填）').optional(),
  new_source: z.string().describe('cell 的新源码内容（替换/插入时必填）').optional(),
  cell_type: z.enum(['code', 'markdown', 'raw']).describe('新 cell 的类型（插入时必填，默认 code）').optional(),
  edit_mode: z.enum(['replace', 'insert', 'delete']).describe('编辑模式：replace（替换，默认）/ insert（插入）/ delete（删除）').optional(),
  insertion_index: z.number().int().min(0).describe('插入位置（0=最前，insert 模式用；不传则追加到末尾）').optional(),
})
type NotebookEditInputType = z.infer<typeof NotebookEditInput>

// 最小化的 notebook JSON 结构（只关心 cells 数组）
interface NotebookCell {
  cell_type: string
  id?: string
  source: string | string[]
  metadata?: Record<string, unknown>
  outputs?: unknown[]
  execution_count?: unknown
}
interface Notebook {
  cells: NotebookCell[]
  metadata?: Record<string, unknown>
  nbformat?: number
  nbformat_minor?: number
}

function sourceToString(source: string | string[] | undefined): string {
  if (!source) return ''
  if (typeof source === 'string') return source
  return source.join('')
}

function stringToSource(s: string): string[] {
  // notebook convention: source 是字符串数组，每行末尾带 \n（除最后一行）
  if (s.length === 0) return []
  const lines = s.split('\n')
  return lines.map((line, i) => (i < lines.length - 1 ? line + '\n' : line))
}

export const NotebookEditTool = buildTool<NotebookEditInputType>({
  name: 'NotebookEdit',
  description: '编辑 Jupyter Notebook（.ipynb）的 cell',
  prompt: `编辑 Jupyter Notebook（.ipynb）文件的单个 cell。

参数：
- notebook_path（必填）：.ipynb 文件绝对路径
- cell_id（可选）：目标 cell 的 ID（替换/删除时必填）
- new_source（可选）：cell 新内容（替换/插入时必填）
- cell_type（可选）：code / markdown / raw（插入时用，默认 code）
- edit_mode（可选）：replace（替换，默认）/ insert（插入）/ delete（删除）
- insertion_index（可选）：插入位置（insert 模式，0=最前，不传=追加末尾）

**硬护栏**：
1. 调用前必须先用 Read 读取该 notebook
2. 文件自上次 Read 后未被外部修改

**三种模式**：
- replace：用 new_source 替换 cell_id 指定的 cell 内容
- insert：在 insertion_index 处插入新 cell（content=new_source, type=cell_type）
- delete：删除 cell_id 指定的 cell

操作后返回改动摘要。`,
  inputSchema: NotebookEditInput,
  jsonSchema: {
    type: 'object',
    properties: {
      notebook_path: { type: 'string', description: '.ipynb 文件绝对路径' },
      cell_id: { type: 'string', description: '目标 cell ID（替换/删除必填）' },
      new_source: { type: 'string', description: 'cell 新内容' },
      cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'], description: '新 cell 类型（默认 code）' },
      edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'replace/insert/delete（默认 replace）' },
      insertion_index: { type: 'integer', minimum: 0, description: '插入位置（insert 模式）' },
    },
    required: ['notebook_path'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  async execute(input, ctx) {
    const { notebook_path } = input
    const mode = input.edit_mode ?? 'replace'

    // 护栏 1：必须先 Read
    const state = ctx.readFileState.get(notebook_path)
    if (!state) {
      return {
        ok: false,
        error: `必须先用 Read 读取该 notebook 后才能编辑: ${notebook_path}`,
        isError: true,
      }
    }

    // 护栏 2：文件未被外部修改
    let currentMtime: number
    try {
      const stats = await stat(notebook_path)
      currentMtime = stats.mtimeMs
    } catch {
      return { ok: false, error: `文件不存在: ${notebook_path}`, isError: true }
    }
    if (currentMtime !== state.mtime) {
      return {
        ok: false,
        error: `文件自上次 Read 后已被外部修改（mtime 变了）。请重新 Read 后再编辑。`,
        isError: true,
      }
    }

    try {
      // 读 + parse
      const raw = await readFile(notebook_path, 'utf8')
      const nb = JSON.parse(raw) as Notebook
      if (!Array.isArray(nb.cells)) {
        return { ok: false, error: '该文件不是有效的 notebook（缺少 cells 数组）', isError: true }
      }

      let actionMsg = ''

      if (mode === 'delete') {
        // 删除 cell
        if (!input.cell_id) {
          return { ok: false, error: 'delete 模式必须提供 cell_id', isError: true }
        }
        const idx = nb.cells.findIndex((c) => c.id === input.cell_id)
        if (idx === -1) {
          return { ok: false, error: `未找到 cell_id: ${input.cell_id}`, isError: true }
        }
        nb.cells.splice(idx, 1)
        actionMsg = `已删除 cell ${input.cell_id}（原位置 ${idx}）`

      } else if (mode === 'insert') {
        // 插入 cell
        if (input.new_source === undefined) {
          return { ok: false, error: 'insert 模式必须提供 new_source', isError: true }
        }
        const newCell: NotebookCell = {
          cell_type: input.cell_type ?? 'code',
          id: `cell-${Date.now()}`,
          source: stringToSource(input.new_source),
          metadata: {},
          ...(input.cell_type === 'code' || !input.cell_type ? { outputs: [], execution_count: null } : {}),
        }
        const insertAt = input.insertion_index ?? nb.cells.length
        nb.cells.splice(Math.min(insertAt, nb.cells.length), 0, newCell)
        actionMsg = `已在位置 ${Math.min(insertAt, nb.cells.length)} 插入 ${newCell.cell_type} cell（id=${newCell.id}）`

      } else {
        // replace
        if (!input.cell_id) {
          return { ok: false, error: 'replace 模式必须提供 cell_id', isError: true }
        }
        if (input.new_source === undefined) {
          return { ok: false, error: 'replace 模式必须提供 new_source', isError: true }
        }
        const idx = nb.cells.findIndex((c) => c.id === input.cell_id)
        if (idx === -1) {
          return { ok: false, error: `未找到 cell_id: ${input.cell_id}`, isError: true }
        }
        nb.cells[idx]!.source = stringToSource(input.new_source)
        if (input.cell_type) nb.cells[idx]!.cell_type = input.cell_type
        actionMsg = `已替换 cell ${input.cell_id}（位置 ${idx}）`
      }

      // checkpoint 备份（原文件）
      await checkpoint(ctx.cwd, notebook_path).catch(() => {})

      // 原子写
      const tmpPath = notebook_path + '.tmp'
      await writeFile(tmpPath, JSON.stringify(nb, null, 1), 'utf8')
      await rename(tmpPath, notebook_path)

      // 更新 readFileState（新 mtime）
      const newStats = await stat(notebook_path)
      ctx.readFileState.set(notebook_path, { mtime: newStats.mtimeMs, readAt: Date.now() })

      // 摘要：cell 列表
      const cellSummary = nb.cells.map((c, i) =>
        `  ${i}. [${c.cell_type}] ${sourceToString(c.source).slice(0, 50).replace(/\n/g, ' ')}`,
      ).join('\n')

      return { ok: true, data: `${actionMsg}。\n\ncells（共 ${nb.cells.length} 个）：\n${cellSummary}` }
    } catch (e) {
      return { ok: false, error: `NotebookEdit 失败: ${(e as Error).message}`, isError: true }
    }
  },
})
