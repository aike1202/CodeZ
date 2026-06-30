### Task 3: Edit 工具（search-replace，须先 Read，唯一/replace_all，复用事务）

**Files:**
- Create: `src/main/tools/builtin/EditTool.ts`
- Test: `src/tests/edit-tool.test.ts`

**Interfaces:**
- Consumes: `Tool`/`ToolContext`；`ReadFingerprintStore.isUnchangedKnown(sessionId, absPath)`（Task 1，先读校验）；`EditTransactionService.backupFile(txId, absPath)` / `getDiff(txId)`（`src/main/services/EditTransactionService.ts`，事务链路与 `apply_patch` 一致）。
- Produces: `class EditTool extends Tool`，`name='Edit'`，`parameters_schema={file_path(req), old_string(req), new_string(req), replace_all?}`。成功返回 JSON `{changedFiles:[relPath], diff, summary:"Edited <rel>", fileHashAfter}`（与 `apply_patch` 同形，供渲染端 Accept/Reject 流复用）；错误以 `Error: ...` 返回。写入后 `ReadFingerprintStore.record` 新 sha（覆盖旧指纹，使后续 Read 不被旧指纹误拦）。
- 关键：`old_string` 匹配前先剥除 Read 返回的 `^\d+\t` 行前缀（逐行），`\r\n` 规范化为 `\n`；0 匹配→`not found`；>1 且非 replace_all→`not unique`。

- [ ] **Step 1: Write the failing test**

```ts
// src/tests/edit-tool.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { EditTool } from '../main/tools/builtin/EditTool'
import { ReadTool } from '../main/tools/builtin/ReadTool'
import { getReadFingerprintStore } from '../main/tools/ReadFingerprintStore'
import type { EditTransactionService } from '../main/services/EditTransactionService'

class MemoryEditTransactionService implements Pick<EditTransactionService, 'backupFile' | 'getDiff'> {
  backedUp = new Set<string>()
  async backupFile(_txId: string, abs: string): Promise<void> {
    try { await fs.readFile(abs); this.backedUp.add(abs) } catch (e: any) { if (e.code === 'ENOENT') { this.backedUp.add(abs); return } throw e }
  }
  async getDiff(_txId: string): Promise<Array<{ path: string; diff: string }>> { return [] }
}

let root: string
const SESSION = 'sess-edit'

async function setup(): Promise<string> {
  root = path.join(os.tmpdir(), `codez-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(root, { recursive: true })
  return root
}

async function readFirst(fp: string) {
  await new ReadTool().execute(JSON.stringify({ file_path: fp }), { workspaceRoot: root, sessionId: SESSION })
}

describe('EditTool', () => {
  beforeEach(async () => {
    await setup()
    getReadFingerprintStore().clear(SESSION)
  })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

  it('未先 Read：返错提示先 Read', async () => {
    const fp = path.join(root, 'a.txt')
    await fs.writeFile(fp, 'hello world')
    const tool = new EditTool()
    const result = await tool.execute(JSON.stringify({ file_path: fp, old_string: 'hello', new_string: 'hi' }), { workspaceRoot: root, sessionId: SESSION })
    expect(result.startsWith('Error:')).toBe(true)
    expect(result).toContain('Read')
    expect(await fs.readFile(fp, 'utf-8')).toBe('hello world')
  })

  it('old_string 0 匹配：返 not found', async () => {
    const fp = path.join(root, 'a.txt')
    await fs.writeFile(fp, 'hello world')
    await readFirst(fp)
    const tool = new EditTool()
    const result = await tool.execute(JSON.stringify({ file_path: fp, old_string: 'missing', new_string: 'x' }), { workspaceRoot: root, sessionId: SESSION })
    expect(result).toContain('not found')
  })

  it('old_string 多处且非 replace_all：返 not unique', async () => {
    const fp = path.join(root, 'a.txt')
    await fs.writeFile(fp, 'foo foo')
    await readFirst(fp)
    const tool = new EditTool()
    const result = await tool.execute(JSON.stringify({ file_path: fp, old_string: 'foo', new_string: 'bar' }), { workspaceRoot: root, sessionId: SESSION })
    expect(result).toContain('not unique')
  })

  it('唯一匹配：写入成功并返回 changedFiles/summary/fileHashAfter', async () => {
    const fp = path.join(root, 'a.txt')
    await fs.writeFile(fp, 'hello world')
    await readFirst(fp)
    const tx = new MemoryEditTransactionService()
    const tool = new EditTool()
    const result = await tool.execute(JSON.stringify({ file_path: fp, old_string: 'hello', new_string: 'hi' }), {
      workspaceRoot: root, sessionId: SESSION, transactionId: 'tx1', editTransactionService: tx as unknown as EditTransactionService
    })
    const parsed = JSON.parse(result)
    expect(parsed.summary).toContain('Edited')
    expect(parsed.changedFiles).toEqual(['a.txt'])
    expect(parsed.fileHashAfter).toMatch(/^[0-9a-f]{64}$/)
    expect(await fs.readFile(fp, 'utf-8')).toBe('hi world')
    expect(tx.backedUp.has(fp)).toBe(true)
  })

  it('replace_all:true 多处全替换', async () => {
    const fp = path.join(root, 'a.txt')
    await fs.writeFile(fp, 'foo foo foo')
    await readFirst(fp)
    const tool = new EditTool()
    const result = await tool.execute(JSON.stringify({ file_path: fp, old_string: 'foo', new_string: 'bar', replace_all: true }), { workspaceRoot: root, sessionId: SESSION })
    const parsed = JSON.parse(result)
    expect(parsed.summary).toContain('Edited')
    expect(await fs.readFile(fp, 'utf-8')).toBe('bar bar bar')
  })

  it('old_string 含 Read 行号前缀：自动剥除后仍能匹配', async () => {
    const fp = path.join(root, 'a.txt')
    await fs.writeFile(fp, 'alpha\nbeta\n')
    await readFirst(fp)
    const tool = new EditTool()
    const result = await tool.execute(JSON.stringify({ file_path: fp, old_string: '1\talpha\n2\tbeta', new_string: '1\tALPHA\n2\tBETA' }), { workspaceRoot: root, sessionId: SESSION })
    const parsed = JSON.parse(result)
    expect(parsed.summary).toContain('Edited')
    expect(await fs.readFile(fp, 'utf-8')).toBe('1\tALPHA\n2\tBETA\n')
  })

  it('workspace 外：拒绝', async () => {
    const outside = path.join(os.tmpdir(), `outside-edit-${Date.now()}.txt`)
    await fs.writeFile(outside, 'x')
    try {
      await readFirst(outside)
      const tool = new EditTool()
      const result = await tool.execute(JSON.stringify({ file_path: outside, old_string: 'x', new_string: 'y' }), { workspaceRoot: root, sessionId: SESSION })
      expect(result.startsWith('Error:')).toBe(true)
    } finally {
      await fs.rm(outside, { force: true })
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/edit-tool.test.ts`
Expected: FAIL，`Cannot find module '../main/tools/builtin/EditTool'`。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/tools/builtin/EditTool.ts
import { Tool, ToolContext } from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { getReadFingerprintStore } from '../ReadFingerprintStore'

interface EditArgs {
  file_path?: string
  old_string?: string
  new_string?: string
  replace_all?: boolean
}

/** 剥除 Read 输出的 `行号\t` 前缀（逐行）。 */
function stripLinePrefix(s: string): string {
  return s.replace(/^(\d+)\t/gm, '')
}

export class EditTool extends Tool {
  get name() {
    return 'Edit'
  }

  get description() {
    return 'Performs exact string replacement in a file. You MUST Read the file in this conversation before editing, or the call fails. old_string must match exactly (including indentation) and be unique — the edit fails otherwise; the Read line prefix (line number + tab) is stripped automatically before matching. Use replace_all: true to replace every occurrence. For creating files or full rewrites use Write instead.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute (or workspace-relative) path of the file to edit.' },
        old_string: { type: 'string', description: 'Exact text to find. Must be unique unless replace_all is true.' },
        new_string: { type: 'string', description: 'Text to replace it with.' },
        replace_all: { type: 'boolean', description: 'If true, replace every occurrence. Default false.' }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as EditArgs
      if (!parsed.file_path) return 'Error: file_path is required.'
      if (typeof parsed.old_string !== 'string' || typeof parsed.new_string !== 'string') {
        return 'Error: old_string and new_string are required.'
      }

      const absolutePath = path.isAbsolute(parsed.file_path)
        ? parsed.file_path
        : path.resolve(context.workspaceRoot, parsed.file_path)
      const normalizedTarget = absolutePath.replace(/\\/g, '/').toLowerCase()
      const normalizedRoot = context.workspaceRoot.replace(/\\/g, '/').toLowerCase()
      if (!normalizedTarget.startsWith(normalizedRoot)) {
        return 'Error: Access denied. Cannot modify file outside of workspace.'
      }

      const sessionId = context.sessionId
      if (!sessionId || !getReadFingerprintStore().isUnchangedKnown(sessionId, absolutePath)) {
        return 'Error: You must Read this file in this conversation before editing it.'
      }

      let fileContent: string
      try {
        fileContent = await fs.readFile(absolutePath, 'utf-8')
      } catch (err: any) {
        if (err.code === 'ENOENT') return 'Error: File not found. Use Write to create it.'
        return `Error: ${err.message}`
      }

      const target = stripLinePrefix(parsed.old_string.replace(/\r\n/g, '\n'))
      const replacement = parsed.new_string.replace(/\r\n/g, '\n')
      const working = fileContent.replace(/\r\n/g, '\n')
      const occurrences = working.split(target).length - 1

      if (occurrences === 0) {
        return 'Error: old_string not found. Ensure exact match including whitespace; re-Read the relevant range before retrying.'
      }
      if (occurrences > 1 && !parsed.replace_all) {
        return `Error: old_string is not unique (${occurrences} matches). Use replace_all: true or expand old_string to be unique.`
      }

      const updated = parsed.replace_all
        ? working.split(target).join(replacement)
        : working.replace(target, replacement)

      if (context.editTransactionService && context.transactionId) {
        try {
          await context.editTransactionService.backupFile(context.transactionId, absolutePath)
        } catch (e: any) {
          return `Error: Failed to backup file before writing: ${e.message}`
        }
      }

      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.writeFile(absolutePath, updated, 'utf-8')

      const newSha = createHash('sha256').update(updated).digest('hex')
      if (sessionId) getReadFingerprintStore().record(sessionId, absolutePath, newSha)

      let diff = ''
      if (context.editTransactionService && context.transactionId) {
        try {
          const diffs = await context.editTransactionService.getDiff(context.transactionId)
          diff = diffs.find((d) => d.path === absolutePath)?.diff || ''
        } catch { diff = '' }
      }
      const rel = path.relative(context.workspaceRoot, absolutePath)
      return JSON.stringify({
        changedFiles: [rel],
        diff,
        summary: `Edited ${rel}`,
        fileHashAfter: newSha
      }, null, 2)
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/edit-tool.test.ts`
Expected: PASS（7 例全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/builtin/EditTool.ts src/tests/edit-tool.test.ts
git commit -m "feat(tools): add Edit tool (search-replace, requires prior Read, reuses transaction)"
```
