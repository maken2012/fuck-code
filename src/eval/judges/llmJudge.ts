// src/eval/judges/llmJudge.ts
// LLM-as-judge 判定器：用独立 LLM 按 rubric 给产出打分。
// 适合开放性任务（没有标准答案的，如"重构代码"、"写文档"）。
//
// 原理：把 rubric + 模型产出（finalText + 关键文件内容）拼成 prompt，
// 让 judge LLM 返回 JSON { score: 0-1, reason: string }。
//
// 注意：LLM judge 有成本和不确定性，硬判定（test/behavior）优先。
import type { Judge, JudgeContext } from '@/eval/judges/types.js'
import type { JudgeResult } from '@/eval/types.js'
import { LLMClient } from '@/llm/LLMClient.js'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

export interface LlmJudgeConfig {
  apiKey?: string
  apiBaseUrl?: string
  provider?: 'anthropic' | 'openai' | 'openai-compatible'
  model?: string
}

export class LlmJudge implements Judge {
  constructor(
    private readonly rubric: string,
    private readonly config: LlmJudgeConfig,
  ) {}

  async judge(ctx: JudgeContext): Promise<JudgeResult> {
    // 收集产出信息：finalText + 工作区里的关键文件（限 ts/js/md）
    const artifacts = await this.collectArtifacts(ctx.workspaceDir)

    const prompt = this.buildPrompt(ctx.finalText, artifacts)
    const client = LLMClient.fromConfig({
      apiKey: this.config.apiKey,
      apiBaseUrl: this.config.apiBaseUrl,
      provider: this.config.provider,
    })

    try {
      let fullText = ''
      for await (const event of client.stream({
        model: this.config.model ?? 'claude-sonnet-4-5-20250929',
        system: '你是一个代码评审员。根据给定的评分标准评估 AI 编码助手的产出。你必须只输出一个 JSON 对象，格式为 {"score": 0.0到1.0的数字, "reason": "简短理由"}，不要输出任何其他内容。',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1024,
        signal: new AbortController().signal,
      })) {
        if (event.type === 'text') {
          fullText += event.textDelta
        }
      }

      return this.parseJudgeResponse(fullText)
    } catch (e) {
      return {
        pass: false,
        score: 0,
        reason: `LLM judge 调用失败：${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }

  /** 收集工作区产出（限制大小，避免 token 爆炸） */
  private async collectArtifacts(workspaceDir: string): Promise<string> {
    const { readdir, stat } = await import('node:fs/promises')
    const MAX_FILES = 10
    const MAX_SIZE = 5000 // 每文件最多 5000 字符
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.py']

    async function scan(dir: string, depth: number): Promise<string[]> {
      if (depth > 3) return []
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      const files: string[] = []
      for (const e of entries) {
        // 跳过 node_modules / .git / 隐藏目录
        if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.fuckcode')) continue
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          files.push(...await scan(full, depth + 1))
        } else if (extensions.some((ext) => e.name.endsWith(ext))) {
          files.push(full)
        }
      }
      return files
    }

    const files = (await scan(workspaceDir, 0)).slice(0, MAX_FILES)
    const parts: string[] = []
    for (const f of files) {
      const rel = f.slice(workspaceDir.length + 1)
      const content = await readFile(f, 'utf8').catch(() => '')
      const trimmed = content.length > MAX_SIZE ? content.slice(0, MAX_SIZE) + '\n...(截断)' : content
      parts.push(`### ${rel}\n\`\`\`\n${trimmed}\n\`\`\``)
    }
    return parts.join('\n\n')
  }

  private buildPrompt(finalText: string, artifacts: string): string {
    return `## 评分标准
${this.rubric}

## AI 助手的最后回复
${finalText.slice(0, 3000)}

## 工作区产出文件
${artifacts || '（无文件产出）'}

---
请根据评分标准评估上述产出。输出 JSON：{"score": 0.0-1.0, "reason": "理由"}`.slice(0, 12000)
  }

  private parseJudgeResponse(text: string): JudgeResult {
    // 提取 JSON（LLM 可能前后有废话）
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return {
        pass: false,
        score: 0,
        reason: `LLM judge 返回无法解析：${text.slice(0, 200)}`,
      }
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as { score?: number; reason?: string }
      const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : 0
      return {
        pass: score >= 0.7, // 0.7 以上算 pass
        score,
        reason: parsed.reason ?? `LLM judge 打分 ${score}`,
        details: { raw: text.slice(0, 500) },
      }
    } catch {
      return {
        pass: false,
        score: 0,
        reason: `LLM judge JSON 解析失败：${text.slice(0, 200)}`,
      }
    }
  }
}
