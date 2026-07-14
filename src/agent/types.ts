// src/agent/types.ts
// queryLoop 的事件契约。TUI 层（Repl）for await 消费这些事件做渲染。
//
// M3 新增 tool_use_start / tool_result，用于工具调用循环的可视化。
// M4 新增 permission_request：工具执行前需要用户确认（checkPermission 返回 ask）。
//   携带 resolve 回调，Repl 显示弹窗后调 resolve('allow'|'deny')，
//   queryLoop 内部 await 该 promise 后继续/跳过该工具。
// M5 新增 compacted：autoCompact 触发后通知 UI（旧消息已压成摘要）。
export type PermissionUserDecision = 'allow' | 'deny'

export type QueryEvent =
  | { type: 'text_delta'; text: string } // 模型流式文本片段
  | { type: 'thinking_delta'; text: string } // thinking/reasoning 片段（深度比对 #8）
  // 深度比对第 53 轮: 工具执行进度（Bash 长命令实时输出）
  | { type: 'tool_progress'; tool: string; lines: string[]; totalLines: number; elapsedMs: number }
  // M3 新增：模型决定调用工具（在执行前 yield）
  | { type: 'tool_use_start'; tool: string; input: unknown }
  // M3 新增：工具执行完毕（含成功/失败 + 内容）
  | {
      type: 'tool_result'
      tool: string
      ok: boolean
      content: string
    }
  // M4 新增：工具执行前需要用户确认。携带 resolve 回调，Repl 弹窗后 resolve。
  // inputSummary：给 UI 显示的简洁摘要（Bash→command，Edit/Write→file_path）。
  | {
      type: 'permission_request'
      tool: string
      input: unknown
      inputSummary: string
      resolve: (decision: PermissionUserDecision) => void
    }
  // M5 新增：autoCompact 触发，messages 已被摘要替换。UI 可提示"已压缩上下文"。
  | { type: 'compacted'; summary: string }
  | { type: 'turn_end'; stopReason: string } // 一轮结束（含 tool_use 轮次）
  | { type: 'usage'; input: number; output: number; cacheRead: number }
  | { type: 'aborted' } // 被用户中断
  | { type: 'error'; error: Error; recoverable: boolean }
  | { type: 'done' } // 整个 queryLoop 结束
