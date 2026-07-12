// src/tests/notebook-edit-tool.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

  it('bounds large notebook output with the shared Read budget', async () => {
    const fp = path.join(root, 'large.ipynb')
    await fs.writeFile(fp, minimalNb('x'.repeat(60_000)))
    const result = await new ReadTool().execute(
      JSON.stringify({ files: [{ file_path: fp }] }),
      { workspaceRoot: root, sessionId: SESSION }
    )

    expect(result.length).toBeLessThan(30_000)
    expect(result).toContain('Notebook content truncated')
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

  it('does not write after cancellation is observed at the final commit point', async () => {
    const fp = path.join(root, 'aborted.ipynb')
    const original = minimalNb()
    await fs.writeFile(fp, original)
    await readFirst(fp)
    const controller = new AbortController()
    const discardBackup = vi.fn(async () => true)
    const tx = {
      backupFile: async () => {
        controller.abort('executor stopped')
        return true
      },
      discardBackup
    }

    const result = await new NotebookEditTool().execute(JSON.stringify({
      notebook_path: fp,
      cell_id: 'cell-0',
      new_source: 'print(2)\n',
      edit_mode: 'replace'
    }), {
      workspaceRoot: root,
      sessionId: SESSION,
      transactionId: 'tx-aborted',
      editTransactionService: tx as any,
      abortSignal: controller.signal
    })

    expect(result).toContain('executor stopped')
    expect(await fs.readFile(fp, 'utf-8')).toBe(original)
    expect(discardBackup).toHaveBeenCalledWith('tx-aborted', fp)
  })

  it('拒绝通过 workspace 内链接修改外部 notebook', async () => {
    const outside = path.join(os.tmpdir(), `outside-notebook-link-${Date.now()}`)
    await fs.mkdir(outside, { recursive: true })
    const outsideFile = path.join(outside, 'n.ipynb')
    const original = minimalNb()
    await fs.writeFile(outsideFile, original)
    try {
      const link = path.join(root, 'external-link')
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      const linkedFile = path.join(link, 'n.ipynb')
      await readFirst(linkedFile)
      const result = await new NotebookEditTool().execute(JSON.stringify({
        notebook_path: linkedFile,
        cell_id: 'cell-0',
        new_source: 'print(2)\n',
        edit_mode: 'replace'
      }), { workspaceRoot: root, sessionId: SESSION })

      expect(result).toContain('Access denied')
      expect(await fs.readFile(outsideFile, 'utf-8')).toBe(original)
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})
