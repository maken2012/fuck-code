// src/services/Config.ts
// Config Service：读 ~/.fuckcode/config.json + 项目级 .fuckcode/config.json，Zod 校验，深合并。
// 设计：对外暴露 loadConfig() async 函数 + Config Effect Service（runtime 用）。
import { Context, Effect, Layer } from 'effect'
import { z } from 'zod'
import { readFile, writeFile, stat, mkdir, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { configPath } from '@/services/Paths.js'

// === Zod Schema（spec 5.4 节） ===
export const ConfigSchema = z.object({
  model: z.string().default('claude-sonnet-4-5-20250929'),
  fallbackModels: z.array(z.string()).default([]).describe('主模型过载/429 时按序尝试的备用模型（最多 3 个）'),
  apiKey: z.string().optional(),
  apiBaseUrl: z.string().optional().describe('Anthropic 兼容 API 的 baseURL（第三方中转/代理）'),
  provider: z.enum(['anthropic', 'openai', 'openai-compatible']).optional().describe('强制指定 provider（覆盖自动判定，用 MiniMax 等 Anthropic 兼容服务时设 anthropic'),
  permissions: z
    .object({
      allow: z.array(z.string()).default([]),
      ask: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .default(() => ({ allow: [], ask: [], deny: [] })),
  permissionMode: z
    .enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
    .default('default'),
  // 深度比对第 59 轮: sandbox 配置（对标 Claude Code sandbox.credentials）
  sandbox: z.object({
    credentials: z.boolean().default(false).describe('阻止 Bash 读取凭证文件（.env/.ssh/.aws）'),
    allowEnv: z.array(z.string()).default([]).describe('sandbox 模式下允许读取的环境变量名'),
  }).default(() => ({ credentials: false, allowEnv: [] })),
  maxTokens: z.number().int().positive().default(8192),
  contextWindow: z.number().int().positive().default(200000),
})
export type ConfigValue = z.infer<typeof ConfigSchema>

// === Service 定义（Effect Context.Tag 模式） ===
export class Config extends Context.Tag('Config')<Config, { readonly value: ConfigValue }>() {}

// === 加载逻辑 ===
// 注：node:fs/promises 在 Node 22 / Bun 1.3 没有 exists（已废弃），
// 用 stat + try/catch 判断文件存在性。
async function readConfigFile(path: string): Promise<Partial<ConfigValue>> {
  try {
    await stat(path)
  } catch {
    return {}  // 文件不存在按空处理
  }
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as Partial<ConfigValue>
  } catch {
    return {}  // 解析失败按空处理，让 schema 用默认值（避免单个坏文件阻塞启动）
  }
}

// 深合并：project 覆盖 user，user 覆盖默认
function deepMerge(
  base: ConfigValue,
  ...overrides: Partial<ConfigValue>[]
): ConfigValue {
  const merged = overrides.reduce(
    (acc: ConfigValue, ov) => ({
      ...acc,
      ...ov,
      permissions: {
        allow: ov.permissions?.allow ?? acc.permissions.allow,
        ask: ov.permissions?.ask ?? acc.permissions.ask,
        deny: ov.permissions?.deny ?? acc.permissions.deny,
      },
    }),
    base,
  )
  return ConfigSchema.parse(merged)
}

export async function loadConfig(opts?: { cwd?: string }): Promise<ConfigValue> {
  const userRaw = await readConfigFile(configPath())
  const cwd = opts?.cwd ?? process.cwd()
  const projectRaw = await readConfigFile(resolve(cwd, '.fuckcode', 'config.json'))
  // 合并顺序：默认 < user < project
  const defaults = ConfigSchema.parse({})
  return deepMerge(defaults, userRaw, projectRaw)
}

// 写盘：把 partial 合并进目标 scope 的 config 文件后原子写回。
// scope='user' 写 ~/.fuckcode/config.json，scope='project' 写 <cwd>/.fuckcode/config.json。
// 只做"单文件层合并"（partial 覆盖该文件现有内容），不跨层合并。
// permissions 子对象特殊处理（深合并 allow/ask/deny），其余字段浅覆盖。
export async function saveConfig(
  partial: Partial<ConfigValue>,
  scope: 'user' | 'project' = 'user',
  opts?: { cwd?: string },
): Promise<void> {
  const targetPath =
    scope === 'user' ? configPath() : resolve(opts?.cwd ?? process.cwd(), '.fuckcode', 'config.json')

  // 读该文件现有内容（不存在按空处理）
  const existing = await readConfigFile(targetPath)

  // 合并 partial 到 existing：permissions 深合并，其余浅覆盖
  const merged: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(partial)) {
    if (key === 'permissions' && existing.permissions && value && typeof value === 'object') {
      merged.permissions = {
        allow: (value as ConfigValue['permissions']).allow ?? existing.permissions?.allow ?? [],
        ask: (value as ConfigValue['permissions']).ask ?? existing.permissions?.ask ?? [],
        deny: (value as ConfigValue['permissions']).deny ?? existing.permissions?.deny ?? [],
      }
    } else {
      merged[key] = value
    }
  }

  // 确保目录存在 + 原子写（.tmp → rename，避免半写损坏）
  const dir = resolve(targetPath, '..')
  await mkdir(dir, { recursive: true }).catch(() => {})
  const tmpPath = targetPath + '.tmp'
  await writeFile(tmpPath, JSON.stringify(merged, null, 2), 'utf8')
  await rename(tmpPath, targetPath)
}

// === Effect Layer（runtime.ts 用） ===
export const ConfigLive = Layer.effect(
  Config,
  Effect.gen(function* () {
    const value = yield* Effect.tryPromise({
      try: () => loadConfig(),
      catch: (e: unknown) => new Error(`加载配置失败: ${String(e)}`),
    })
    return Config.of({ value })
  }),
)
