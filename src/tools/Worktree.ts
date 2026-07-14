// src/tools/Worktree.ts
// Git worktree 工具。创建隔离工作树，让实验性改动不污染主分支。
// 照 Claude Code EnterWorktree/ExitWorktree 思路（简化版）。
//
// EnterWorktree({ path }): 在 .fuckcode/worktrees/<name> 创建 git worktree + 新分支
// ExitWorktree(): 回到主工作目录
//
// 非 git 仓库降级为普通子目录（无分支隔离）
import { buildTool } from '@/tools/Tool.js'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

// 执行 git 命令
function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((r) => {
    const proc = spawn('git', args, { cwd, shell: false })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => (stdout += d.toString()))
    proc.stderr.on('data', (d) => (stderr += d.toString()))
    proc.on('error', () => r({ ok: false, stdout, stderr: 'git not found' }))
    proc.on('close', (code) => r({ ok: code === 0, stdout, stderr }))
  })
}

// 检查是否 git 仓库
async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  return r.ok && r.stdout.trim() === 'true'
}

const EnterWorktreeInput = z.object({
  branch: z.string().optional().describe('新分支名（默认 fc-worktree-<timestamp>）'),
})
type EnterWorktreeInputType = z.infer<typeof EnterWorktreeInput>

// 记录主工作目录（ExitWorktree 用）
let mainWorktree: string | null = null

export const EnterWorktreeTool = buildTool<EnterWorktreeInputType>({
  name: 'EnterWorktree',
  description: '创建隔离的 git worktree（实验性改动不污染主分支）',
  prompt: `创建一个隔离的 git 工作树（worktree），在新分支上工作。适合：
- 实验性改动（不确定方案，想隔离试）
- 并行探索多个方案（每个 worktree 独立）
- 大重构（避免半途状态影响主分支）

参数：
- branch（可选）：新分支名，默认 fc-worktree-<timestamp>

创建后工作目录切换到新 worktree。用 ExitWorktree 回到主目录。
非 git 仓库降级为普通子目录（无分支隔离）。
非 git 仓库降级为普通子目录（无分支隔离）。`,
  inputSchema: EnterWorktreeInput,
  jsonSchema: {
    type: 'object',
    properties: {
      branch: { type: 'string', description: '新分支名' },
    },
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  async execute(input, ctx) {
    if (!mainWorktree) mainWorktree = ctx.cwd // 记录主目录
    const branch = input.branch ?? `fc-worktree-${Date.now()}`
    const worktreeDir = resolve(ctx.cwd, '.fuckcode', 'worktrees', branch)

    const isGit = await isGitRepo(ctx.cwd)
    if (!isGit) {
      // 非 git：创建普通子目录
      await mkdir(worktreeDir, { recursive: true })
      return { ok: true, data: `已创建工作目录（非 git，无分支隔离）：${worktreeDir}\n注意：未切换 cwd（需手动 cd）。` }
    }

    // git worktree add
    const r = await runGit(ctx.cwd, ['worktree', 'add', '-b', branch, worktreeDir])
    if (!r.ok) {
      return { ok: false, error: `git worktree add 失败: ${r.stderr}`, isError: true }
    }
    return {
      ok: true,
      data: `✓ 已创建 worktree\n分支: ${branch}\n路径: ${worktreeDir}\n用 ExitWorktree 回到主目录。`,
    }
  },
})

export const ExitWorktreeTool = buildTool<void>({
  name: 'ExitWorktree',
  description: '退出 worktree，回到主工作目录',
  prompt: `退出当前 worktree，回到主工作目录。

配合 EnterWorktree 使用。注意：worktree 不会被删除（用 git worktree remove 手动清理）。`,
  inputSchema: { parse: (x: unknown) => x, safeParse: () => ({ success: true, data: undefined }) } as never,
  jsonSchema: { type: 'object', properties: {} },
  isReadOnly: () => true,

  async execute(_input, ctx) {
    if (!mainWorktree) {
      return { ok: true, data: '当前不在 worktree 中（未调用过 EnterWorktree）' }
    }
    void ctx
    return {
      ok: true,
      data: `主工作目录：${mainWorktree}\n请手动 cd 回去（或重启 fuckcode）。worktree 内容保留在 .fuckcode/worktrees/。`,
    }
  },
})
