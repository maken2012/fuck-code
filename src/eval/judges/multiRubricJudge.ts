// src/eval/judges/multiRubricJudge.ts
// 多维度 rubric 判定器：架构设计/需求分析类任务用。
//
// 与 LlmJudge 的区别：
// - 多个评分维度（每个有权重），不是单一 rubric
// - judge LLM 返回各维度独立分数 + 理由
// - 按权重加权算总分，超 passThreshold 算 pass
// - 结果含 dimensionScores，报告里展示各维度得分
//
// prompt 结构：逐维度列出 rubric，要求返回
// {"dimensions": [{"name": "可扩展性", "score": 0.8, "reason": "..."}], "overall": 0.75}
import type { Judge, JudgeContext } from '@/eval/judges/types.js'
import type { JudgeResult, DimensionScore, RubricDimension } from '@/eval/types.js'
import { LLMClient } from '@/llm/LLMClient.js'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

export interface MultiRubricJudgeConfig {
  apiKey?: string
  apiBaseUrl?: string
  provider?: 'anthropic' | 'openai' | 'openai-compatible'
  model?: string
}

interface ParsedDimensionScore {
  name: string
  score: number
  reason: string
}

export class MultiRubricJudge implements Judge {
  constructor(
    private readonly dimensions: RubricDimension[],
    private readonly passThreshold: number = 0.7,
    private readonly config: MultiRubricJudgeConfig = {},
  ) {}

  async judge(ctx: JudgeContext): Promise<JudgeResult> {
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
        system: this.buildSystemPrompt(),
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 4096, // 多维度 reason 容易超 2048，给足空间避免 JSON 截断
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
        reason: `multi-rubric judge 调用失败：${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }

  private buildSystemPrompt(): string {
    const dimList = this.dimensions
      .map((d, i) => `  ${i + 1}. ${d.name}（权重 ${(d.weight * 100).toFixed(0)}%）：${d.criteria}`)
      .join('\n')

    return `你是一个资深软件架构评审员。你需要根据以下评分维度，对 AI 编码助手的产出逐维度打分。

评分维度：
${dimList}

评分规则：
- 每个维度打 0.0-1.0 的分数
- reason 必须简短（最多 15 个字），不要长篇大论
- 你必须只输出一个 JSON 对象，格式严格如下：
{
  "dimensions": [
    {"name": "${this.dimensions[0]?.name ?? '维度1'}", "score": 0.0到1.0, "reason": "简短理由"},
    ...
  ],
  "overall": "整体评价（简短）"
}
不要输出任何其他内容（不要 markdown 代码块标记）。`
  }

  private buildPrompt(finalText: string, artifacts: string): string {
    return `## 任务产出

### AI 助手的最后回复
${finalText.slice(0, 3000)}

### 工作区产出文件
${artifacts || '（无文件产出）'}

---
请按评分维度逐项打分。`.slice(0, 12000)
  }

  private parseJudgeResponse(text: string): JudgeResult {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return {
        pass: false,
        score: 0,
        reason: `multi-rubric judge 返回无法解析：${text.slice(0, 200)}`,
      }
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        dimensions?: ParsedDimensionScore[]
        overall?: string
      }

      if (!parsed.dimensions || !Array.isArray(parsed.dimensions)) {
        return {
          pass: false,
          score: 0,
          reason: `multi-rubric judge 返回缺少 dimensions 数组`,
        }
      }

      // 把 judge 返回的分数和我们的维度定义对齐（按 name 匹配）
      const dimensionScores = alignDimensionScores(this.dimensions, parsed.dimensions)

      // 按权重加权算总分
      const weightedTotal = computeWeightedTotal(dimensionScores)

      const pass = weightedTotal >= this.passThreshold

      // 拼判定原因：总分 + 各维度简表
      const dimBreakdown = dimensionScores
        .map((d) => `  ${d.name}: ${(d.score * 100).toFixed(0)}%（权重 ${(d.weight * 100).toFixed(0)}%，${d.reason}）`)
        .join('\n')

      return {
        pass,
        score: weightedTotal,
        reason: `加权总分 ${(weightedTotal * 100).toFixed(0)}%（阈值 ${(this.passThreshold * 100).toFixed(0)}%）${parsed.overall ? '\n' + parsed.overall : ''}\n${dimBreakdown}`,
        details: { overall: parsed.overall, raw: text.slice(0, 500) },
        dimensionScores,
      }
    } catch {
      return {
        pass: false,
        score: 0,
        reason: `multi-rubric judge JSON 解析失败：${text.slice(0, 200)}`,
      }
    }
  }

  /** 收集工作区产出（复用 LlmJudge 的逻辑） */
  private async collectArtifacts(workspaceDir: string): Promise<string> {
    const { readdir } = await import('node:fs/promises')
    const MAX_FILES = 15
    const MAX_SIZE = 5000
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.py', '.go']

    async function scan(dir: string, depth: number): Promise<string[]> {
      if (depth > 3) return []
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      const files: string[] = []
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.fuckcode')) continue
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          files.push(...(await scan(full, depth + 1)))
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
}

// ─── 导出的纯函数（可独立测试） ────────────────────────────

/** 把 judge 返回的分数和维度定义对齐（按 name 模糊匹配） */
export function alignDimensionScores(
  dimensions: RubricDimension[],
  rawScores: ParsedDimensionScore[],
): DimensionScore[] {
  return dimensions.map((dim) => {
    const matched = rawScores.find(
      (d) => d.name === dim.name || d.name.includes(dim.name) || dim.name.includes(d.name),
    )
    const rawScore = typeof matched?.score === 'number' ? Math.max(0, Math.min(1, matched.score)) : 0
    return {
      name: dim.name,
      weight: dim.weight,
      score: rawScore,
      reason: matched?.reason ?? '未评分',
    }
  })
}

/** 按权重加权算总分 */
export function computeWeightedTotal(scores: DimensionScore[]): number {
  return scores.reduce((sum, d) => sum + d.score * d.weight, 0)
}
