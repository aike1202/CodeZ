### Task 7: NotebookEdit 工具 + Read 对 .ipynb 特化渲染

**Files:**
- Create: `src/main/tools/builtin/NotebookUtils.ts`
- Create: `src/main/tools/builtin/NotebookEditTool.ts`
- Modify: `src/main/tools/builtin/ReadTool.ts`（在二进制检测后、行切片前插入 `.ipynb` 分支）
- Test: `src/tests/notebook-edit-tool.test.ts`

**Interfaces:**
- Consumes: `Tool`/`ToolContext`；`ReadFingerprintStore.isUnchangedKnown`；`EditTransactionService.backupFile`。
- Produces:
  - `NotebookUtils.ts` 导出：`parseNotebook(text:string): NbFormat`、`renderNotebook(nb):string`、`writeNotebook(nb):string`、`cellIdOf(cell, index):string`、`stringToSource(s:string):string[]`、`sourceToString(src):string`。
  - `class NotebookEditTool extends Tool`，`name='NotebookEdit'`，`parameters_schema={notebook_path(req), cell_id?, cell_type?, new_source?, edit_mode?('replace'|'insert'|'delete')}`。
- Read 特化：当 `file_path` 以 `.ipynb` 结尾时，解析为 notebook，输出 `<cell id="...">` 文本块（仍走 sha 去重与 `record`），不进 cat-n 行切片。

**说明：** 零依赖手写 .ipynb v4 JSON（`nbformat:4`），不引 notebook 库。`cell_id` 取 Read 输出中 `<cell id="...">` 的值；`replace/delete` 必填 `cell_id`；`insert` 省略 `cell_id` 表示插到开头，`cell_type` 缺省按 `code`。

- [ ] **Step 1: Write the failing test**

```ts
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
  await new ReadTool().execute(JSON.stringify({ file_path: fp }), { workspaceRoot: root, sessionId: SESSION })
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
    const r = await new ReadTool().execute(JSON.stringify({ file_path: fp }), { workspaceRoot: root, sessionId: SESSION })
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/notebook-edit-tool.test.ts`
Expected: FAIL，`Cannot find module '../main/tools/builtin/NotebookEditTool'`。

- [ ] **Step 3: Write NotebookUtils**

```ts
// src/main/tools/builtin/NotebookUtils.ts
export interface NbCell {
  cell_type: string
  source: string | string[]
  outputs?: any[]
  metadata?: Record<string, any>
  id?: string
  execution_count?: any
}

export interface NbFormat {
  cells: NbCell[]
  metadata: Record<string, any>
  nbformat: number
  nbformat_minor: number
}

export function parseNotebook(text: string): NbFormat {
  const nb = JSON.parse(text)
  if (!Array.isArray(nb.cells)) throw new Error('Invalid notebook: missing cells array.')
  return nb as NbFormat
}

export function writeNotebook(nb: NbFormat): string {
  return JSON.stringify(nb, null, 1)
}

export function cellIdOf(cell: NbCell, index: number): string {
  return cell.id || `cell-${index}`
}

export function sourceToString(src: string | string[]): string {
  return Array.isArray(src) ? src.join('') : src
}

export function stringToSource(s: string): string[] {
  if (s === '') return []
  const lines = s.split('\n')
  return lines.map((l, i) => (i < lines.length - 1 ? l + '\n' : l))
}

export function renderNotebook(nb: NbFormat): string {
  const blocks: string[] = []
  nb.cells.forEach((cell, i) => {
    const id = cellIdOf(cell, i)
    const type = cell.cell_type || 'code'
    const lines: string[] = [`<cell id="${id}" type="${type}">`]
    lines.push(sourceToString(cell.source))
    if (type === 'code' && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
      lines.push('<outputs>')
      lines.push(JSON.stringify(cell.outputs, null, 1))
      lines.push('</outputs>')
    }
    lines.push('</cell>')
    blocks.push(lines.join('\n'))
  })
  return blocks.join('\n\n')
}
```

- [ ] **Step 4: Write NotebookEditTool**

```ts
// src/main/tools/builtin/NotebookEditTool.ts
import { Tool, ToolContext } from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { getReadFingerprintStore } from '../ReadFingerprintStore'
import { parseNotebook, writeNotebook, cellIdOf, stringToSource, type NbFormat, type NbCell } from './NotebookUtils'

interface NotebookEditArgs {
  notebook_path?: string
  cell_id?: string
  cell_type?: string
  new_source?: string
  edit_mode?: 'replace' | 'insert' | 'delete'
}

export class NotebookEditTool extends Tool {
  get name() {
    return 'NotebookEdit'
  }

  get description() {
    return 'Replaces, inserts, or deletes a single cell in a Jupyter notebook (.ipynb). You MUST Read the notebook in this conversation first — this tool fails otherwise. notebook_path is absolute. cell_id is the id shown in the Read tool <cell id="..."> output; required for replace and delete. edit_mode defaults to replace. insert adds a new cell after the given cell_id (or at the beginning if omitted) — cell_type is required when inserting (defaults to code).'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        notebook_path: { type: 'string', description: 'Absolute (or workspace-relative) path of the .ipynb file.' },
        cell_id: { type: 'string', description: 'The id from <cell id="...">. Required for replace/delete; optional for insert.' },
        cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'], description: 'Cell type for insert. Defaults to code.' },
        new_source: { type: 'string', description: 'The new cell source. Required for replace and insert.' },
        edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'Default replace.' }
      },
      required: ['notebook_path']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as NotebookEditArgs
      if (!parsed.notebook_path) return 'Error: notebook_path is required.'

      const absolutePath = path.isAbsolute(parsed.notebook_path)
        ? parsed.notebook_path
        : path.resolve(context.workspaceRoot, parsed.notebook_path)
      const normalizedTarget = absolutePath.replace(/\\/g, '/').toLowerCase()
      const normalizedRoot = context.workspaceRoot.replace(/\\/g, '/').toLowerCase()
      if (!normalizedTarget.startsWith(normalizedRoot)) {
        return 'Error: Access denied. Cannot modify file outside of workspace.'
      }
      if (!absolutePath.toLowerCase().endsWith('.ipynb')) {
        return 'Error: notebook_path must point to a .ipynb file.'
      }

      const sessionId = context.sessionId
      if (!sessionId || !getReadFingerprintStore().isUnchangedKnown(sessionId, absolutePath)) {
        return 'Error: You must Read this notebook in this conversation before editing it.'
      }

      const mode = parsed.edit_mode || 'replace'
      const text = await fs.readFile(absolutePath, 'utf-8')
      const nb = parseNotebook(text)

      const idx = parsed.cell_id !== undefined
        ? nb.cells.findIndex((c, i) => cellIdOf(c, i) === parsed.cell_id)
        : -1

      if (mode === 'replace') {
        if (parsed.cell_id === undefined) return 'Error: cell_id is required for replace.'
        if (idx < 0) return `Error: cell_id "${parsed.cell_id}" not found.`
        if (typeof parsed.new_source !== 'string') return 'Error: new_source is required for replace.'
        nb.cells[idx] = { ...nb.cells[idx], source: stringToSource(parsed.new_source) }
      } else if (mode === 'insert') {
        if (typeof parsed.new_source !== 'string') return 'Error: new_source is required for insert.'
        const cellType = parsed.cell_type || 'code'
        const newCell: NbCell = { cell_type: cellType, source: stringToSource(parsed.new_source), metadata: {}, outputs: cellType === 'code' ? [] : undefined }
        if (parsed.cell_id === undefined || idx < 0) {
          nb.cells.unshift(newCell)
        } else {
          nb.cells.splice(idx + 1, 0, newCell)
        }
      } else if (mode === 'delete') {
        if (parsed.cell_id === undefined) return 'Error: cell_id is required for delete.'
        if (idx < 0) return `Error: cell_id "${parsed.cell_id}" not found.`
        nb.cells.splice(idx, 1)
      } else {
        return `Error: unknown edit_mode "${mode}".`
      }

      if (context.editTransactionService && context.transactionId) {
        try { await context.editTransactionService.backupFile(context.transactionId, absolutePath) }
        catch (e: any) { return `Error: Failed to backup file before writing: ${e.message}` }
      }

      const updated = writeNotebook(nb)
      await fs.writeFile(absolutePath, updated, 'utf-8')

      const newSha = createHash('sha256').update(updated).digest('hex')
      if (sessionId) getReadFingerprintStore().record(sessionId, absolutePath, newSha)
      return `Edited cell in ${absolutePath}. New sha256: ${newSha}`
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }
}
```

- [ ] **Step 5: Add .ipynb branch to ReadTool**

在 `ReadTool.ts` 顶部新增 import：
```ts
import { parseNotebook, renderNotebook } from './NotebookUtils'
```
在 `execute` 内、`const sha = ...` 之后、`if (sessionId) { ... isUnchanged ... }` 之**前**插入 .ipynb 特化分支（仍在 sha 计算之后，使去重指纹基于原始文件字节）：

```ts
      const sha = createHash('sha256').update(buffer).digest('hex')
      const sessionId = context.sessionId
      if (sessionId) {
        const store = getReadFingerprintStore()
        if (store.isUnchanged(sessionId, absolutePath, sha)) {
          return 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.'
        }
      }

      // .ipynb 特化：渲染为 <cell id="..."> 文本块（仍是纯文本，不算图片/PDF 入能力）
      if (absolutePath.toLowerCase().endsWith('.ipynb')) {
        try {
          const nb = parseNotebook(buffer.toString('utf-8'))
          if (sessionId) getReadFingerprintStore().record(sessionId, absolutePath, sha)
          return `${renderNotebook(nb)}\n\nSHA256: ${sha}`
        } catch (e: any) {
          // 解析失败则按普通文本回退（下方逻辑继续）
        }
      }
```

（其后保留原有的行切片逻辑不动。）

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/tests/notebook-edit-tool.test.ts`
Expected: PASS（7 例全绿）。

- [ ] **Step 7: Commit**

```bash
git add src/main/tools/builtin/NotebookUtils.ts src/main/tools/builtin/NotebookEditTool.ts src/main/tools/builtin/ReadTool.ts src/tests/notebook-edit-tool.test.ts
git commit -m "feat(tools): add NotebookEdit + .ipynb cell rendering in Read (zero-dep v4 JSON)"
```
