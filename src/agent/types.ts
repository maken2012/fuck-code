// src/agent/types.ts
// queryLoop 的事件契约。TUI 层（Repl）for await 消费这些事件做渲染。
export type QueryEvent =
  | { type: 'text_delta'; text: string } // 模型流式文本片段
  | { type: 'turn_end'; stopReason: string } // 一轮结束
  | { type: 'usage'; input: number; output: number; cacheRead: number }
  | { type: 'aborted' } // 被用户中断
  | { type: 'error'; error: Error; recoverable: boolean }
  | { type: 'done' } // 整个 queryLoop 结束
