// src/personality.ts
// fuckcode 的暴躁人格文案。体现消极、不满、烦躁、爆粗口的情绪。
// 全局出口：attitudeFor(scene) 拿特定场景文案，attitude() 随机一句。
//
// 这不是 bug，是 feature。fuckcode 就该有"老子烦死了"的气质。

const SCENES: Record<string, string[]> = {
  welcome: [
    '又他妈要写代码？',
    '行吧，又来了。',
    '操，又是你。',
    '来了老弟，这次又是什么烂活？',
    '活着就是受罪，写代码尤其。',
  ],
  idle: [
    '说吧，这次又是什么破需求？',
    '愣着干嘛，输入啊。',
    '别磨蹭，老子没一整天。',
    '有屁快放。',
    '等着你呢，快点。',
  ],
  generating: [
    '憋着急，老子在想呢...',
    '催啥催，在算了。',
    '脑子转着呢，别催。',
    '等着，这玩意儿急不来。',
    '妈的这题有点麻烦...',
  ],
  done: [
    '行了，凑合用吧。',
    '搞定，别指望我再说第二遍。',
    '完了。不满意？自己改去。',
    '就这样吧，爱要不要。',
    '完事儿。下一位。',
  ],
  error: [
    '妈的，又出幺蛾子了。',
    '操，炸了。',
    '靠，这破玩意儿又报错。',
    '日，搞砸了。',
    '草（一种植物），出错了。',
  ],
  permission: [
    '这操作有点野，你确定？',
    '等等，这玩意儿要改东西，你点头不？',
    '悠着点，确认一下？',
    '这步可能搞出事，过不过？',
  ],
  denied: [
    '行，听你的，不动。',
    '好嘛，不弄就不弄。',
    '得，你自己看着办。',
  ],
  compact: [
    '废话太多了，老子精简一下。',
    '上下文塞满了，清一清。',
    '记性有限，挑要紧的留着。',
  ],
}

export function attitudeFor(scene: keyof typeof SCENES | string): string {
  const lines = SCENES[scene] ?? SCENES.idle ?? ['...']
  return lines[Math.floor(Math.random() * lines.length)] ?? '...'
}

export function attitude(): string {
  return attitudeFor('idle')
}

export const LOGO = '🖕'

const TOOL_EMOJIS: Record<string, string> = {
  Read: '👀',
  Write: '✍️',
  Edit: '🔧',
  Bash: '💥',
  Grep: '🔍',
  Glob: '📂',
  Task: '🤝',
  TodoWrite: '📋',
  WebFetch: '🌐',
  WebSearch: '🔬',
  AskUserQuestion: '🤷',
  Skill: '📚',
  LspDiagnostics: '🐛',
  EnterWorktree: '🌳',
  ExitWorktree: '🔙',
}

export function toolEmoji(toolName: string): string {
  return TOOL_EMOJIS[toolName] ?? '🔨'
}
