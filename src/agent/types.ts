// src/agent/types.ts
// queryLoop 的事件契约。TUI 层（Repl）for await 消费这些事件做渲染。
//
// M3 新增 tool_use_start / tool_result，用于工具调用循环的可视化。
export type QueryEvent =
  | { type: 'text_delta'; text: string } // 模型流式文本片段
  // M3 新增：模型决定调用工具（在执行前 yield）
  | { type: 'tool_use_start'; tool: string; input: unknown }
  // M3 新增：工具执行完毕（含成功/失败 + 内容）
  | {
      type: 'tool_result'
      tool: string
      ok: boolean
      content: string
    }
  | { type: 'turn_end'; stopReason: string } // 一轮结束（含 tool_use 轮次）
  | { type: 'usage'; input: number; output: number; cacheRead: number }
  | { type: 'aborted' } // 被用户中断
  | { type: 'error'; error: Error; recoverable: boolean }
  | { type: 'done' } // 整个 queryLoop 结束
