// tests/tools/dynamicLoader.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadDynamicTools } from '@/tools/dynamicLoader.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-dyn-test-' + process.pid)

beforeEach(async () => {
  await mkdir(resolve(tmpDir, '.fuckcode', 'tools'), { recursive: true })
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

test('目录不存在返回空', async () => {
  expect(await loadDynamicTools('/tmp/nonexistent-fc-test-xyz')).toEqual([])
})

test('加载合法的 default export 工具', async () => {
  await writeFile(
    resolve(tmpDir, '.fuckcode', 'tools', 'hello.ts'),
    `import { buildTool } from '${resolve(process.cwd(), 'src/tools/Tool.js')}'
export default buildTool({
  name: 'hello',
  description: '打招呼',
  prompt: '说你好',
  inputSchema: { parse: (x: unknown) => x, safeParse: () => ({ success: true, data: {} }) } as any,
  execute: async () => ({ ok: true, data: 'hi' }),
})`,
  )
  const tools = await loadDynamicTools(tmpDir)
  expect(tools.length).toBe(1)
  expect(tools[0]?.name).toBe('hello')
})

test('跳过非法导出', async () => {
  await writeFile(
    resolve(tmpDir, '.fuckcode', 'tools', 'bad.ts'),
    'export default { foo: "not a tool" }',
  )
  const tools = await loadDynamicTools(tmpDir)
  expect(tools.length).toBe(0)
})

test('单个文件加载失败不阻塞其他', async () => {
  await writeFile(resolve(tmpDir, '.fuckcode', 'tools', 'broken.ts'), 'throw new Error("boom")')
  // broken 文件 import 时抛错，应被跳过
  const tools = await loadDynamicTools(tmpDir)
  expect(tools.length).toBe(0)
})
