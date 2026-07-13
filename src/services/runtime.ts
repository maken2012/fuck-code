// src/services/runtime.ts
// 程序级 Effect Runtime 单例。
// 设计原则：Service 对外暴露 async API（内部 Runtime.runPromise），
// 上层（agent loop、TUI）完全不感知 Effect。
import { Effect, Runtime, Layer, Scope } from 'effect'
import { Config, ConfigLive } from '@/services/Config.js'
import { Logger, LoggerLive } from '@/services/Logger.js'

// 构建主 Layer（合并所有 Service 的实现）
// 注意：ConfigLive 是常量 Layer.effect；LoggerLive 是工厂函数 (opts?) => Layer<Logger>
export function buildMainLive(opts?: { verbose?: boolean }) {
  return Layer.mergeAll(
    ConfigLive,
    LoggerLive({ verbose: opts?.verbose ?? false }),
  )
}

// 用 Layer.toRuntime 构建 runtime。
// effect@3.21.4 实测（偏离 spec 原文的必要修正）：
//   - 不存在 Runtime.addLayer（spec 原文写法在当前版本不可用）。
//   - Layer.toRuntime(live) 依赖 Scope，用 Scope.make() + Effect.provideService 注入。
//   - ConfigLive 内部读文件（Effect.tryPromise），Layer.toRuntime 是异步 Effect，
//     不能用 Effect.runSync；必须用 Effect.runPromise 异步求值。
//     因此 buildRuntime 返回 Promise，getRuntime 缓存该 Promise。
//   - 进程级单例，scope 永不 close（与 runtime 生命周期一致），不泄漏。
export async function buildRuntime(opts?: {
  verbose?: boolean
}): Promise<Runtime.Runtime<Config | Logger>> {
  const live = buildMainLive(opts)
  const scope = Effect.runSync(Scope.make())
  const runtime = await Effect.runPromise(
    Effect.provideService(Scope.Scope, scope)(Layer.toRuntime(live)),
  )
  return runtime as Runtime.Runtime<Config | Logger>
}

// 全局 runtime 单例（启动期求值一次；缓存 Promise，多次调用幂等）
let _runtimePromise: Promise<Runtime.Runtime<Config | Logger>> | null = null
export function getRuntime(opts?: {
  verbose?: boolean
}): Promise<Runtime.Runtime<Config | Logger>> {
  if (!_runtimePromise) {
    _runtimePromise = buildRuntime(opts)
  }
  return _runtimePromise
}

// 便捷工具：在 Effect 上下文外运行一个 Effect（用全局 runtime）
export async function runEffect<A, E>(
  effect: Effect.Effect<A, E, Config | Logger>,
  opts?: { verbose?: boolean },
): Promise<A> {
  const rt = await getRuntime(opts)
  return Runtime.runPromise(rt)(effect)
}

// 对外"假装不是 Effect"的 service 获取函数
export async function getConfig(): Promise<{
  value: import('@/services/Config.js').ConfigValue
}> {
  return runEffect(
    Effect.map(Config, (c) => c as { value: import('@/services/Config.js').ConfigValue }),
  )
}

export async function getLogger(): Promise<
  import('@/services/Logger.js').LoggerService
> {
  return runEffect(
    Effect.map(Logger, (l) => l as import('@/services/Logger.js').LoggerService),
  )
}
