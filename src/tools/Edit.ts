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
import { checkpoint } from '@/tools/checkpoint.js'
import { resolve } from 'node:path'
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
      // 深度比对第 41 轮: mtime 容差——mtime 变了但内容没变时仍放行（对标 Claude Code）
      // 场景：云同步（iCloud/Dropbox）、杀软扫描、git checkout 触发 mtime 变化但内容不变
      const curStat = await stat(file_path)
      if (curStat.mtimeMs !== state.mtime) {
        // mtime 变了——读文件内容对比是否真的变了
        const currentContent = await readFile(file_path, 'utf8')
        if (state.lastContent && currentContent === state.lastContent) {
          // 内容未变——mtime 变化是外部因素（云同步/杀软），放行
          // 静默更新 mtime，继续编辑
        } else {
          return {
            ok: false,
            error: `文件自上次 Read 后被外部修改（mtime 变化且内容不同），请重新 Read 后再 Edit: ${file_path}`,
            isError: true,
          }
        }
      }

      const content = await readFile(file_path, 'utf8')

      // old_string 存在性（含引号归一化兜底）
      let actualOldString = old_string
      if (!content.includes(old_string)) {
        // 引号归一化：模型可能输出直引号 ' " 但文件里是弯引号 ' ' " "
        const normalizedContent = normalizeQuotes(content)
        const normalizedOld = normalizeQuotes(old_string)
        if (normalizedContent.includes(normalizedOld)) {
          // 找到匹配——提取文件里的真实字符串（保留原始排版）
          const idx = normalizedContent.indexOf(normalizedOld)
          actualOldString = content.slice(idx, idx + old_string.length)
        } else {
          return {
            ok: false,
            error: `old_string 在文件中不存在: ${JSON.stringify(old_string.slice(0, 60))}`,
            isError: true,
          }
        }
      }

      // 唯一性：非 replace_all 时，actualOldString 必须唯一
      // 深度比对第 65 轮: 多匹配时提供行号提示（对标 Claude Code actualOldString 位置提示）
      if (!replaceAll) {
        const occurrences = countOccurrences(content, actualOldString)
        if (occurrences > 1) {
          // 找出匹配所在的行号
          const lines = content.split('\n')
          const matchLines: number[] = []
          let searchFrom = 0
          for (let i = 0; i < lines.length; i++) {
            const line = lines.slice(0, i + 1).join('\n').slice(searchFrom)
            if (line.includes(actualOldString)) {
              matchLines.push(i + 1)
              searchFrom += line.indexOf(actualOldString) + actualOldString.length
            }
          }
          const lineHint = matchLines.slice(0, 5).join(', ')
          return {
            ok: false,
            error: `old_string 在文件中出现 ${occurrences} 次（行 ${lineHint}${occurrences > 5 ? '...' : ''}）。请提供更长的上下文使匹配唯一，或设 replace_all=true`,
            isError: true,
          }
        }
      }

      // 执行替换（用 actualOldString——可能经引号归一化调整过）
      const newContent = replaceAll
        ? content.split(actualOldString).join(new_string)
        : content.replace(actualOldString, () => new_string)

      // v1.6: 写前 checkpoint 备份（失败不阻塞编辑，/rewind 可回滚）
      await checkpoint(ctx.cwd, file_path).catch(() => {})

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

      const replacedCount = replaceAll ? countOccurrences(content, actualOldString) : 1
      // 深度比对第 35 轮: 编辑后自动类型检查（对标 Claude Code didChange/didSave → LSP diagnostics）
      // 只对 .ts/.tsx 文件 + 有 node_modules/.bin/tsc 时触发（不阻塞，失败不报错）
      let typeCheckHint = ''
      if (/\.(ts|tsx|mts|cts)$/.test(file_path)) {
        try {
          const { spawn } = await import('node:child_process')
          const { existsSync } = await import('node:fs')
          const tscPath = resolve(ctx.cwd, 'node_modules', '.bin', 'tsc')
          if (existsSync(tscPath)) {
            const result = await new Promise<{ ok: boolean; output: string }>((r) => {
              const proc = spawn(tscPath, ['--noEmit', '--pretty', 'false'], {
                cwd: ctx.cwd, shell: true, timeout: 15000,
              })
              let out = ''
              proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
              proc.stderr?.on('data', (d: Buffer) => { out += d.toString() })
              proc.on('close', (code) => r({ ok: code === 0, output: out }))
              proc.on('error', () => r({ ok: true, output: '' })) // tsc 不可用不阻塞
            })
            if (!result.ok && result.output) {
              // 找到本文件的错误行
              const shortPath = file_path.replace(ctx.cwd + '/', '')
              const fileErrors = result.output.split('\n').filter((l) => l.includes(shortPath))
              if (fileErrors.length > 0) {
                typeCheckHint = `\n\n[!] 编辑后有 ${fileErrors.length} 个类型错误:\n${fileErrors.slice(0, 5).join('\n')}`
              }
            }
          }
        } catch { /* 类型检查失败不阻塞编辑 */ }
      }
      return {
        ok: true,
        data: `已替换 ${file_path}（${replacedCount} 处）${typeCheckHint}`,
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

// 引号归一化：弯引号 → 直引号（用于模糊匹配 old_string）
// 模型（尤其非 Anthropic）常把文件里的 ' ' " " 输出成 ' "
function normalizeQuotes(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")  // ' ' ‚ ‛ → '
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')   // " " „ ‟ → "
    .replace(/\u00A0/g, ' ')                        // nbsp → space
}
