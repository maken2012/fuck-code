// src/services/Paths.ts
// ~/.fuckcode 下的路径解析辅助。纯函数，无副作用。
//
// 注意：Bun 的 node:os.homedir() 不会读取 process.env.HOME（与 Node 行为不同），
// 测试需要通过覆盖 HOME 来隔离文件系统副作用，因此这里优先读 process.env.HOME，
// 未设置时回退到 homedir()，保证真实运行环境下行为不变。
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

function home(): string {
  return process.env.HOME ?? homedir()
}

export function fuckcodeDir(): string {
  return resolve(home(), '.fuckcode')
}

export function configPath(): string {
  return resolve(fuckcodeDir(), 'config.json')
}

export function projectsDir(): string {
  return resolve(fuckcodeDir(), 'projects')
}

// 给 cwd 生成稳定 hash，用于隔离不同项目的会话存储
export function projectHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16)
}

// 某个项目的会话存储目录
export function projectSessionDir(cwd: string): string {
  return resolve(projectsDir(), projectHash(cwd))
}
