# fuckcode M5 会话 + 压缩 实现计划

**Goal:** 让对话历史持久化到磁盘（JSONL），重启后能恢复；长对话达到阈值时自动压缩成摘要。

**Architecture:** 新增 `src/services/Session.ts`（JSONL 读写 + compact boundary）+ `src/utils/tokens.ts`（token 估算）。改造 queryLoop：每轮结束写 JSONL + 触发 autoCompact。改造 Repl：`/resume` 列出历史会话。

**前置：** M4 完成（97 tests）

**关键设计（照设计文档 5.1-5.2）：**
1. **JSONL**：`~/.fuckcode/projects/<hash>/<sessionId>.jsonl`，每行一个消息
2. **compact boundary**：摘要作为特殊消息，后续 loadMessages 只返回 boundary 后
3. **autoCompact 阈值**：`contextWindow - 13000`（默认 187000 token）
4. **token 估算**：粗估（bytes/token 比率），不调精确 API

---

## 文件结构

```
src/services/Session.ts     # Task 1 — JSONL 存储 + compact boundary
src/utils/tokens.ts         # Task 2 — token 粗估
src/agent/compact.ts        # Task 3 — autoCompact 摘要生成
src/agent/queryLoop.ts      # Task 4 — 改造：写 JSONL + 触发 compact
src/repl/Repl.tsx           # Task 5 — /resume 命令
tests/services/Session.test.ts
tests/utils/tokens.test.ts
```

## Task 1: src/services/Session.ts（TDD）

```typescript
export interface SessionMeta { id: string; createdAt: number; lastMessage: number; title: string; messageCount: number }

export async function createSession(cwd: string): Promise<string>  // 返回 sessionId，创建 jsonl 文件
export async function appendMessages(sessionId: string, cwd: string, messages: ChatMessage[]): Promise<void>
export async function loadMessages(sessionId: string, cwd: string): Promise<ChatMessage[]>  // 含 compact boundary 处理
export async function listSessions(cwd: string): Promise<SessionMeta[]>  // 读 sessions.json 索引
export async function writeCompactBoundary(sessionId: string, cwd: string, summary: string): Promise<void>
```

JSONL 格式：每行 `JSON.stringify(message)`。compact boundary 是特殊 user 消息：
`{"role":"user","content":[{"type":"text","text":"<compact>...</compact>","_meta":{"compactBoundary":true}}]}`

loadMessages 读全部行，**只返回最后一个 compactBoundary 之后的消息**（boundary 本身的摘要作为新起点）。

测试：创建/追加/加载/恢复、compact boundary 截断、sessions.json 索引。

## Task 2: src/utils/tokens.ts（TDD）

```typescript
export function estimateTokens(text: string): number {
  // 粗估：英文 ~4 字符/token，中文 ~1.5 字符/token
  // 混合：按字符类型加权
}
export function estimateMessagesTokens(messages: ChatMessage[]): number
```

测试：英文文本、中文文本、混合、空。

## Task 3: src/agent/compact.ts（TDD）

```typescript
export function getCompactThreshold(contextWindow: number): number {
  return contextWindow - 13000  // 默认 187000
}
export async function compactConversation(messages, opts): Promise<{ summary: string; boundary: ChatMessage }> {
  // 调 LLM 生成摘要（用专门的 compact prompt）
  // 返回摘要文本 + compact boundary 消息
}
```

compact prompt（中文）：把历史发模型，让它生成保留关键决策/文件改动/未完成任务的摘要。

⚠️ compactConversation 调 LLM——测试时 mock。

## Task 4: queryLoop 改造

每轮 turn 结束后：
1. `appendMessages(sessionId, cwd, [本轮的 user + assistant 消息])`
2. 下一轮开始前检查 `estimateMessagesTokens(messages) > getCompactThreshold(config.contextWindow)`
3. 触发 compactConversation → writeCompactBoundary → messages 只保留 boundary 后

QueryLoopOpts 加 `sessionId?: string, cwd: string`（已有）。

## Task 5: Repl /resume

`/resume` 命令：调 listSessions，显示列表，用户选序号恢复。简化：`/resume` 直接列最近 5 个，输入数字恢复。

## 测试目标

M4 的 97 + Session 8 + tokens 4 + compact 3 = 112 tests

## 关键约束

1. **JSONL 原子追加**：用 appendFile，不要读-改-写
2. **compact boundary 是边界**：loadMessages 截断，不混旧消息
3. **autoCompact 不破坏正在进行的对话**：只在新轮开始前触发
4. **不实现精确 token 计数**（M6 可加 API count_tokens）
