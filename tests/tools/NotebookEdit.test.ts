// tests/tools/NotebookEdit.test.ts
// NotebookEdit 工具测试：替换/插入/删除 cell + 未读拒绝 + mtime 护栏
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { NotebookEditTool } from '@/tools/NotebookEdit.js'
import { ReadTool } from '@/tools/Read.js'

const tmpDir = resolve(process.env.TMPDIR || '/tmp', 'fc-nb-test-' + process.pid)

function makeCtx() {
  return {
    cwd: tmpDir,
    abortSignal: new AbortController().signal,
    readFileState: new Map<string, { mtime: number; readAt: number }>(),
  }
}

function makeNotebook(): Record<string, unknown> {
  return {
    cells: [
      { cell_type: 'markdown', id: 'cell-1', source: ['# Title\n', 'desc'], metadata: {} },
      { cell_type: 'code', id: 'cell-2', source: ['print(1)\n'], metadata: {}, outputs: [], execution_count: null },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  }
}

beforeEach(async () => { await mkdir(tmpDir, { recursive: true }) })
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }) })

test('NotebookEdit 元数据', () => {
  expect(NotebookEditTool.name).toBe('NotebookEdit')
  expect(NotebookEditTool.isReadOnly?.()).toBe(false)
  expect(NotebookEditTool.isConcurrencySafe?.()).toBe(false)
})

test('未先 Read 直接编辑被拒绝', async () => {
  const ctx = makeCtx()
  const path = resolve(tmpDir, 'test.ipynb')
  await writeFile(path, JSON.stringify(makeNotebook()), 'utf8')
  const r = await NotebookEditTool.execute({ notebook_path: path, cell_id: 'cell-1', new_source: 'x' }, ctx)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toContain('必须先用 Read')
})

test('替换 cell 内容', async () => {
  const ctx = makeCtx()
  const path = resolve(tmpDir, 'test.ipynb')
  await writeFile(path, JSON.stringify(makeNotebook()), 'utf8')
  await ReadTool.execute({ file_path: path }, ctx)
  const r = await NotebookEditTool.execute({ notebook_path: path, cell_id: 'cell-2', new_source: 'print(42)' }, ctx)
  expect(r.ok).toBe(true)
  // 验证落盘内容
  const nb = JSON.parse(await readFile(path, 'utf8'))
  expect(nb.cells[1].source).toEqual(['print(42)'])
})

test('插入新 cell', async () => {
  const ctx = makeCtx()
  const path = resolve(tmpDir, 'test.ipynb')
  await writeFile(path, JSON.stringify(makeNotebook()), 'utf8')
  await ReadTool.execute({ file_path: path }, ctx)
  const r = await NotebookEditTool.execute({
    notebook_path: path, edit_mode: 'insert', new_source: '## Section',
    cell_type: 'markdown', insertion_index: 0,
  }, ctx)
  expect(r.ok).toBe(true)
  const nb = JSON.parse(await readFile(path, 'utf8'))
  expect(nb.cells.length).toBe(3)
  expect(nb.cells[0].cell_type).toBe('markdown')
  expect(nb.cells[0].source).toEqual(['## Section'])
})

test('删除 cell', async () => {
  const ctx = makeCtx()
  const path = resolve(tmpDir, 'test.ipynb')
  await writeFile(path, JSON.stringify(makeNotebook()), 'utf8')
  await ReadTool.execute({ file_path: path }, ctx)
  const r = await NotebookEditTool.execute({
    notebook_path: path, cell_id: 'cell-1', edit_mode: 'delete',
  }, ctx)
  expect(r.ok).toBe(true)
  const nb = JSON.parse(await readFile(path, 'utf8'))
  expect(nb.cells.length).toBe(1)
  expect(nb.cells[0].id).toBe('cell-2')
})

test('文件被外部修改后编辑被拒绝（mtime 护栏）', async () => {
  const ctx = makeCtx()
  const path = resolve(tmpDir, 'test.ipynb')
  await writeFile(path, JSON.stringify(makeNotebook()), 'utf8')
  await ReadTool.execute({ file_path: path }, ctx)
  // 模拟外部修改
  await new Promise((r) => setTimeout(r, 20))
  await writeFile(path, JSON.stringify(makeNotebook()), 'utf8')
  const r = await NotebookEditTool.execute({ notebook_path: path, cell_id: 'cell-1', new_source: 'x' }, ctx)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toContain('外部修改')
})
