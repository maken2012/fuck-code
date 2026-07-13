// src/tools/Edit.ts
// 字符串替换工具。照设计文档 4.3 节。两个硬护栏：
//   1. 必须先 Read（readFileState 有记录）—— 防止盲改没看过的文件
//   2. 文件未被外部修改（stat.mtimeMs === state.mtime）—— 防止 stale edit
// old_string 必须存在；多个匹配且非 replace_all 报错（唯一性要求）。
// 原子写 + 写完更新 readFileState。
//
// isReadOnly: false，isConcurrencySafe: false。
import { readFile, writeFile, rename, stat } from 'node:fs/promises'
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'

const EditInput = z.object({
  file_path: z.string().describe('要编辑的文件绝对路径'),
  old_string: z.string().describe('要替换的字符串（必须存在）'),
  new_string: z.string().describe('替换后的字符串'),
  replace_all: z.boolean().describe('替换所有匹配（默认 false）').optional(),
})
type EditInputType = z.infer<typeof EditInput>

export const EditTool = buildTool<EditInputType>({
  name: 'Edit',
  description: '字符串替换（必须先 Read，且文件未被外部修改）',
  prompt: `对文件做字符串替换。

参数：
- file_path（必填）：文件绝对路径
- old_string（必填）：要被替换的字符串，必须在文件中存在
- new_string（必填）：替换为的内容
- replace_all（可选）：true 时替换所有匹配；默认 false（要求 old_string 唯一）

**两个硬护栏**：
1. 调用前必须先用 Read 读取该文件（readFileState 有记录）
2. 文件自上次 Read 后未被外部修改（mtimeMs 必须与记录一致）

如果 old_string 在文件中出现多次且未设 replace_all=true，会拒绝（避免误改多处）。
写入采用原子操作（写临时文件再 rename）。`,
  inputSchema: EditInput,
  jsonSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '要编辑的文件绝对路径' },
      old_string: { type: 'string', description: '要替换的字符串（必须存在）' },
      new_string: { type: 'string', description: '替换后的字符串' },
      replace_all: { type: 'boolean', description: '替换所有匹配（默认 false）' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  async execute(input, ctx) {
    const { file_path, old_string, new_string } = input
    const replaceAll = input.replace_all === true

    // 护栏 1：必须先 Read
    const state = ctx.readFileState.get(file_path)
    if (!state) {
      return {
        ok: false,
        error: `必须先用 Read 读取该文件后才能 Edit: ${file_path}`,
        isError: true,
      }
    }

    try {
      // 护栏 2：文件未被外部修改（mtime 必须与记录一致）
      const curStat = await stat(file_path)
      if (curStat.mtimeMs !== state.mtime) {
        return {
          ok: false,
          error: `文件自上次 Read 后被外部修改（mtime 变化），请重新 Read 后再 Edit: ${file_path}`,
          isError: true,
        }
      }

      const content = await readFile(file_path, 'utf8')

      // old_string 存在性
      if (!content.includes(old_string)) {
        return {
          ok: false,
          error: `old_string 在文件中不存在: ${JSON.stringify(old_string.slice(0, 60))}`,
          isError: true,
        }
      }

      // 唯一性：非 replace_all 时，old_string 必须唯一
      if (!replaceAll) {
        const occurrences = countOccurrences(content, old_string)
        if (occurrences > 1) {
          return {
            ok: false,
            error: `old_string 在文件中出现 ${occurrences} 次（要求唯一）。如需全部替换请设 replace_all=true`,
            isError: true,
          }
        }
      }

      // 执行替换
      const newContent = replaceAll
        ? content.split(old_string).join(new_string)
        : content.replace(old_string, new_string)

      // 原子写
      const tmpPath = `${file_path}.tmp.${process.pid}`
      await writeFile(tmpPath, newContent, 'utf8')
      await rename(tmpPath, file_path)

      // 更新 readFileState
      const newStat = await stat(file_path)
      ctx.readFileState.set(file_path, {
        mtime: newStat.mtimeMs,
        readAt: Date.now(),
      })

      const replacedCount = replaceAll ? countOccurrences(content, old_string) : 1
      return {
        ok: true,
        data: `已替换 ${file_path}（${replacedCount} 处）`,
      }
    } catch (e) {
      return { ok: false, error: `Edit 失败: ${(e as Error).message}`, isError: true }
    }
  },
})

// 计算 oldString 在 content 中出现的次数（基于 split-1）
function countOccurrences(content: string, oldString: string): number {
  if (oldString === '') return 0
  return content.split(oldString).length - 1
}
