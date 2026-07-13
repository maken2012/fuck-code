// src/services/Config.ts
// Config Service：读 ~/.fuckcode/config.json + 项目级 .fuckcode/config.json，Zod 校验，深合并。
// 设计：对外暴露 loadConfig() async 函数 + Config Effect Service（runtime 用）。
import { Context, Effect, Layer } from 'effect'
import { z } from 'zod'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { configPath } from '@/services/Paths.js'

// === Zod Schema（spec 5.4 节） ===
export const ConfigSchema = z.object({
  model: z.string().default('claude-sonnet-4-5-20250929'),
  apiKey: z.string().optional(),
  apiBaseUrl: z.string().optional().describe('Anthropic 兼容 API 的 baseURL（第三方中转/代理）'),
  permissions: z
    .object({
      allow: z.array(z.string()).default([]),
      ask: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .default({}),
  permissionMode: z
    .enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
    .default('default'),
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
