// src/eval/isolation.ts
// 工作区隔离管理。每个评测任务跑在独立的临时目录里，互不污染。
//
// 3 种模式：
// - scratch：mkdtemp + 写手写文件（最快，适合算法题/纯函数任务）
// - from-repo：git clone --depth 1 + 可选 checkout（适合真实仓库任务）
// - from-snapshot：cp -r 本地目录（适合多轮累积任务的预置场景）
//
// 所有工作区放在 os.tmpdir() 下的 fuckcode-eval-<pid>/ 子目录里，
// runner 跑完后统一 cleanup。
import type { WorkspaceSetup } from '@/eval/types.js'
import { mkdir, writeFile, rm, cp, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { spawn } from 'node:child_process'

/** 基础临时目录：所有 eval 工作区的根 */
function evalTmpRoot(): string {
  return join(tmpdir(), `fuckcode-eval-${process.pid}`)
}

/**
 * WorkspaceManager：创建和清理隔离工作区。
 * 无状态类（每次 create 独立目录），便于并发。
 */
export class WorkspaceManager {
  /** 已创建的工作区列表（cleanup 时用） */
  private created: string[] = []

  /**
   * 创建隔离工作区。
   * @returns 工作区绝对路径
   */
  async create(setup: WorkspaceSetup, taskId: string): Promise<string> {
    // taskId 净化成文件名安全
    const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const baseDir = join(evalTmpRoot(), `${safeId}-${Date.now()}`)
    await mkdir(baseDir, { recursive: true })

    let workspaceDir: string
    switch (setup.type) {
      case 'scratch':
        workspaceDir = await this.createScratch(setup, baseDir)
        break
      case 'from-repo':
        workspaceDir = await this.createFromRepo(setup, baseDir)
        break
      case 'from-snapshot':
        workspaceDir = await this.createFromSnapshot(setup, baseDir)
        break
    }

    this.created.push(workspaceDir)
    return workspaceDir
  }

  /** scratch：写 files 映射 */
  private async createScratch(
    setup: Extract<WorkspaceSetup, { type: 'scratch' }>,
    baseDir: string,
  ): Promise<string> {
    for (const [relPath, content] of Object.entries(setup.files)) {
      const absPath = join(baseDir, relPath)
      await mkdir(dirname(absPath), { recursive: true })
      await writeFile(absPath, content, 'utf8')
    }
    return baseDir
  }

  /** from-repo：git clone */
  private async createFromRepo(
    setup: Extract<WorkspaceSetup, { type: 'from-repo' }>,
    baseDir: string,
  ): Promise<string> {
    const args = ['clone']
    if (setup.depth && !setup.commit) {
      args.push('--depth', String(setup.depth))
    }
    args.push(setup.repo, baseDir)

    await this.runGit(args, tmpdir()) // clone 到 baseDir

    // 如果指定了 commit，fetch 后 checkout
    if (setup.commit) {
      // 浅克隆可能不含目标 commit，先 unshallow 或 fetch
      await this.runGit(['fetch', '--depth=1', 'origin', setup.commit], baseDir).catch(() => {})
      await this.runGit(['checkout', setup.commit], baseDir)
    }

    return baseDir
  }

  /** from-snapshot：cp -r */
  private async createFromSnapshot(
    setup: Extract<WorkspaceSetup, { type: 'from-snapshot' }>,
    baseDir: string,
  ): Promise<string> {
    const src = resolve(setup.snapshotDir)
    await cp(src, baseDir, { recursive: true })
    return baseDir
  }

  /** 清理单个工作区 */
  async cleanup(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true })
    this.created = this.created.filter((d) => d !== dir)
  }

  /** 清理所有已创建的工作区（runner 结束时调） */
  async cleanupAll(): Promise<void> {
    await Promise.all(this.created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})))
    this.created = []
    // 尝试删根目录（可能还有别的 pid 的残留，不强制）
    await rm(evalTmpRoot(), { recursive: true, force: true }).catch(() => {})
  }

  /** 执行 git 命令 */
  private runGit(args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, { cwd, shell: false })
      let stderr = ''
      proc.stderr.on('data', (d) => (stderr += d.toString()))
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr}`))
      })
    })
  }
}

/** 执行 shell 命令（判定器也用这个） */
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((r) => {
    const proc = spawn(command, { cwd, shell: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
      // 3s 后强杀
      setTimeout(() => proc.kill('SIGKILL'), 3000)
    }, timeoutMs)

    proc.stdout.on('data', (d) => (stdout += d.toString()))
    proc.stderr.on('data', (d) => (stderr += d.toString()))
    proc.on('error', () => {
      clearTimeout(timer)
      r({ ok: false, stdout, stderr: stderr || 'spawn error', exitCode: null, timedOut: false })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      r({ ok: code === 0 && !timedOut, stdout, stderr, exitCode: code, timedOut })
    })
  })
}

/** 读取文件内容（判定器用，绕过 Read 工具的行号格式） */
export async function readFileRaw(filePath: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(filePath, 'utf8')
}

/** 检查文件是否存在 */
export async function fileExists(filePath: string): Promise<boolean> {
  const { access } = await import('node:fs/promises')
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}
