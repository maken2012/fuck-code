// src/agent/autoMemory.ts
// 自动记忆提取。对话中检测用户表达的偏好/纠正/项目约定，自动存为 memory。
// 照 Claude Code automatic memory 思路（简化版——用关键词检测而非 LLM 判断，零成本）。
//
// 触发条件（用户消息含这些模式）：
// - "以后都..." / "默认..." / "总是..." / "不要..." / "别再..." → preference
// - "这个项目用..." / "我们项目..." → project
// - "记住..." / "别忘了..." → feedback
//
// 提取后调 saveMemory 持久化。每条记忆用 hash 去重。
import { saveMemory } from '@/instruction/memory.js'

// 检测模式
const PATTERNS: { regex: RegExp; type: 'preference' | 'project' | 'feedback'; label: string }[] = [
  { regex: /(以后|默认|总是|每次|都应该|请始终)[^。！？]*?(用|不要|别|避免)[^。！？]*/i, type: 'preference', label: '偏好' },
  { regex: /(不要|别再|禁止|千万别)[^。！？]*/i, type: 'feedback', label: '禁忌' },
  { regex: /(记住|别忘了|记得|记一下)[^。！？]*/i, type: 'feedback', label: '要记的事' },
  { regex: /(这个项目|我们项目|本项目)[^。！？]*?(用|是基于|采用)[^。！？]*/i, type: 'project', label: '项目约定' },
]

export interface ExtractedMemory {
  type: 'preference' | 'project' | 'feedback'
  content: string
  name: string
}

// 从用户消息提取值得记住的内容
export function extractMemories(userMessage: string): ExtractedMemory[] {
  const results: ExtractedMemory[] = []
  const seen = new Set<string>()

  for (const { regex, type } of PATTERNS) {
    const matches = userMessage.matchAll(new RegExp(regex.source, 'gi'))
    for (const match of matches) {
      const text = match[0]?.trim()
      if (!text || text.length < 5 || text.length > 200) continue
      // 去重（同一段话可能匹配多个模式）
      const key = text.slice(0, 30)
      if (seen.has(key)) continue
      seen.add(key)
      results.push({
        type,
        content: text,
        name: `auto-${type}-${Buffer.from(text).toString('base64').slice(0, 8)}`,
      })
    }
  }
  return results
}

// 检查并自动保存记忆（queryLoop 每轮后调）
export async function autoSaveMemories(cwd: string, userMessage: string): Promise<number> {
  const memories = extractMemories(userMessage)
  let saved = 0
  for (const mem of memories) {
    try {
      await saveMemory(cwd, mem.name, `自动提取：${mem.content.slice(0, 40)}`, mem.type, mem.content)
      saved++
    } catch {
      // 保存失败跳过
    }
  }
  return saved
}
