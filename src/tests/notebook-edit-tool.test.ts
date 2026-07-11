// src/tests/notebook-edit-tool.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { NotebookEditTool } from '../main/tools/builtin/NotebookEditTool'
import { ReadTool } from '../main/tools/builtin/ReadTool'
import { getReadFingerprintStore } from '../main/tools/ReadFingerprintStore'

let root: string
const SESSION = 'sess-nb'

function minimalNb(source = 'print(1)\n'): string {
  return JSON.stringify({
    cells: [{ cell_type: 'code', source: [source], metadata: {}, outputs: [], id: 'cell-0' }],
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' } },
    nbformat: 4,
    nbformat_minor: 5
  }, null, 1)
}

async function setup(): Promise<string> {
  root = path.join(os.tmpdir(), `codez-nb-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(root, { recursive: true })
  return root
}
async function readFirst(fp: string) {
  await new ReadTool().execute(JSON.stringify({ files: [{ file_path: fp }] }), { workspaceRoot: root, sessionId: SESSION })
}

describe('NotebookEditTool', () => {
  beforeEach(async () => {
    await setup()
    getReadFingerprintStore().clear(SESSION)
  })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

  it('Read .ipynb 渲染 <cell id>', async () => {
    const fp = path.join(root, 'n.ipynb')
    await fs.writeFile(fp, minimalNb())
    const r = await new ReadTool().execute(JSON.stringify({ files: [{ file_path: fp }] }), { workspaceRoot: root, sessionId: SESSION })
    expect(r).toContain('<cell id="cell-0"')
    expect(r).toContain('print(1)')
  })

  it('replace：替换 cell 源，nbformat 不变', async () => {
    const fp = path.join(root, 'n.ipynb')
    await fs.writeFile(fp, minimalNb())
    await readFirst(fp)
    const tool = new NotebookEditTool()
    const result = await tool.execute(JSON.stringify({ notebook_path: fp, cell_id: 'cell-0', new_source: 'print(2)\n', edit_mode: 'replace' }), { workspaceRoot: root, sessionId: SESSION })
    expect(result).toContain('Edited cell')
    const after = JSON.parse(await fs.readFile(fp, 'utf-8'))
    expect(after.nbformat).toBe(4)
    expect(after.nbformat_minor).toBe(5)
    expect(after.cells[0].source.join('')).toBe('print(2)\n')
  })

  it('insert 缺 cell_id：插到开头', async () => {
    const fp = path.join(root, 'n.ipynb')
    await fs.writeFile(fp, minimalNb())
    await readFirst(fp)
    const tool = new NotebookEditTool()
    await tool.execute(JSON.stringify({ notebook_path: fp, new_source: 'import os\n', cell_type: 'code', edit_mode: 'insert' }), { workspaceRoot: root, sessionId: SESSION })
    const after = JSON.parse(await fs.readFile(fp, 'utf-8'))
    expect(after.cells.length).toBe(2)
    expect(after.cells[0].source.join('')).toBe('import os\n')
  })

  it('insert 给定 cell_id：插到其后', async () => {
    const fp = path.join(root, 'n.ipynb')
    await fs.writeFile(fp, minimalNb())
    await readFirst(fp)
    const tool = new NotebookEditTool()
    await tool.execute(JSON.stringify({ notebook_path: fp, cell_id: 'cell-0', new_source: 'x=1\n', cell_type: 'code', edit_mode: 'insert' }), { workspaceRoot: root, sessionId: SESSION })
    const after = JSON.parse(await fs.readFile(fp, 'utf-8'))
    expect(after.cells.length).toBe(2)
    expect(after.cells[1].source.join('')).toBe('x=1\n')
  })

  it('delete：移除 cell', async () => {
    const fp = path.join(root, 'n.ipynb')
    await fs.writeFile(fp, minimalNb())
    await readFirst(fp)
    const tool = new NotebookEditTool()
    await tool.execute(JSON.stringify({ notebook_path: fp, cell_id: 'cell-0', edit_mode: 'delete' }), { workspaceRoot: root, sessionId: SESSION })
    const after = JSON.parse(await fs.readFile(fp, 'utf-8'))
    expect(after.cells.length).toBe(0)
  })

  it('cell_id 未命中：返错', async () => {
    const fp = path.join(root, 'n.ipynb')
    await fs.writeFile(fp, minimalNb())
    await readFirst(fp)
    const tool = new NotebookEditTool()
    const result = await tool.execute(JSON.stringify({ notebook_path: fp, cell_id: 'nope', new_source: 'y\n', edit_mode: 'replace' }), { workspaceRoot: root, sessionId: SESSION })
    expect(result.startsWith('Error:')).toBe(true)
    expect(result).toContain('cell_id')
  })

  it('未先 Read：返错', async () => {
    const fp = path.join(root, 'n.ipynb')
    await fs.writeFile(fp, minimalNb())
    const tool = new NotebookEditTool()
    const result = await tool.execute(JSON.stringify({ notebook_path: fp, cell_id: 'cell-0', new_source: 'z\n', edit_mode: 'replace' }), { workspaceRoot: root, sessionId: SESSION })
    expect(result.startsWith('Error:')).toBe(true)
    expect(result).toContain('Read')
  })
})
