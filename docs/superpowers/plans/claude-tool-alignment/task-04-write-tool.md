### Task 4: Write 工具（整体覆写，须先 Read 才能覆盖，新建可直接写）

**Files:**
- Create: `src/main/tools/builtin/WriteTool.ts`
- Test: `src/tests/write-tool.test.ts`

**Interfaces:**
- Consumes: `Tool`/`ToolContext`；`ReadFingerprintStore.isUnchangedKnown(sessionId, absPath)`；`EditTransactionService.backupFile(txId, absPath)`（事务，可回滚）。
- Produces: `class WriteTool extends Tool`，`name='Write'`，`parameters_schema={file_path(req), content(req)}`。成功返回 JSON `{changedFiles:[relPath], diff, summary:"Wrote <rel>", fileHashAfter}`（与 `apply_patch` 同形，供渲染端 Accept/Reject 流复用）；错误以 `Error: ...` 返回。语义：新建文件可直接写；覆盖已存在文件须本会话先 Read（`isUnchangedKnown` 命中）；写后 `record` 新 sha。workspace 外拒绝。

- [ ] **Step 1: Write the failing test**

```ts
// src/tests/write-tool.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { WriteTool } from '../main/tools/builtin/WriteTool'
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
const SESSION = 'sess-write'

async function setup(): Promise<string> {
  root = path.join(os.tmpdir(), `codez-write-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(root, { recursive: true })
  return root
}
async function readFirst(fp: string) {
  await new ReadTool().execute(JSON.stringify({ file_path: fp }), { workspaceRoot: root, sessionId: SESSION })
}

describe('WriteTool', () => {
  beforeEach(async () => {
    await setup()
    getReadFingerprintStore().clear(SESSION)
  })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

  it('新建文件：直接写入成功', async () => {
    const fp = path.join(root, 'new.txt')
    const tool = new WriteTool()
    const result = await tool.execute(JSON.stringify({ file_path: fp, content: 'created' }), { workspaceRoot: root, sessionId: SESSION })
    const parsed = JSON.parse(result)
    expect(parsed.summary).toContain('Wrote')
    expect(parsed.changedFiles).toEqual(['new.txt'])
    expect(await fs.readFile(fp, 'utf-8')).toBe('created')
  })

  it('覆盖已存在但未 Read：返错须先 Read', async () => {
    const fp = path.join(root, 'exist.txt')
    await fs.writeFile(fp, 'old')
    const tool = new WriteTool()
    const result = await tool.execute(JSON.stringify({ file_path: fp, content: 'new' }), { workspaceRoot: root, sessionId: SESSION })
    expect(result.startsWith('Error:')).toBe(true)
    expect(result).toContain('Read')
    expect(await fs.readFile(fp, 'utf-8')).toBe('old')
  })

  it('覆盖已 Read 的文件：整体覆写成功并可回滚（事务备份）', async () => {
    const fp = path.join(root, 'exist.txt')
    await fs.writeFile(fp, 'old')
    await readFirst(fp)
    const tx = new MemoryEditTransactionService()
    const tool = new WriteTool()
    const result = await tool.execute(JSON.stringify({ file_path: fp, content: 'brand new' }), {
      workspaceRoot: root, sessionId: SESSION, transactionId: 'tx1', editTransactionService: tx as unknown as EditTransactionService
    })
    const parsed = JSON.parse(result)
    expect(parsed.summary).toContain('Wrote')
    expect(await fs.readFile(fp, 'utf-8')).toBe('brand new')
    expect(tx.backedUp.has(fp)).toBe(true)
  })

  it('workspace 外：拒绝', async () => {
    const outside = path.join(os.tmpdir(), `outside-write-${Date.now()}.txt`)
    try {
      const tool = new WriteTool()
      const result = await tool.execute(JSON.stringify({ file_path: outside, content: 'x' }), { workspaceRoot: root, sessionId: SESSION })
      expect(result.startsWith('Error:')).toBe(true)
    } finally {
      await fs.rm(outside, { force: true })
    }
  })

  it('缺 content：返错', async () => {
    const tool = new WriteTool()
    const result = await tool.execute(JSON.stringify({ file_path: path.join(root, 'a.txt') }), { workspaceRoot: root, sessionId: SESSION })
    expect(result.startsWith('Error:')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/write-tool.test.ts`
Expected: FAIL，`Cannot find module '../main/tools/builtin/WriteTool'`。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/tools/builtin/WriteTool.ts
import { Tool, ToolContext } from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { getReadFingerprintStore } from '../ReadFingerprintStore'

interface WriteArgs {
  file_path?: string
  content?: string
}

export class WriteTool extends Tool {
  get name() {
    return 'Write'
  }

  get description() {
    return 'Writes a file to the local filesystem, overwriting if one exists. Use to create a new file, or to fully replace one you have already Read in this conversation. Overwriting an existing file you have NOT Read fails — use Edit for partial changes instead. Writes go through the edit transaction and can be rolled back with rollback_last_edit.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute (or workspace-relative) path of the file to write.' },
        content: { type: 'string', description: 'The full new content of the file.' }
      },
      required: ['file_path', 'content']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as WriteArgs
      if (!parsed.file_path) return 'Error: file_path is required.'
      if (typeof parsed.content !== 'string') return 'Error: content is required.'

      const absolutePath = path.isAbsolute(parsed.file_path)
        ? parsed.file_path
        : path.resolve(context.workspaceRoot, parsed.file_path)
      const normalizedTarget = absolutePath.replace(/\\/g, '/').toLowerCase()
      const normalizedRoot = context.workspaceRoot.replace(/\\/g, '/').toLowerCase()
      if (!normalizedTarget.startsWith(normalizedRoot)) {
        return 'Error: Access denied. Cannot modify file outside of workspace.'
      }

      const sessionId = context.sessionId
      const exists = await fs.access(absolutePath).then(() => true).catch(() => false)
      if (exists) {
        if (!sessionId || !getReadFingerprintStore().isUnchangedKnown(sessionId, absolutePath)) {
          return 'Error: You must Read this file in this conversation before overwriting it. Use Edit for partial changes.'
        }
      }

      if (context.editTransactionService && context.transactionId) {
        try {
          await context.editTransactionService.backupFile(context.transactionId, absolutePath)
        } catch (e: any) {
          return `Error: Failed to backup file before writing: ${e.message}`
        }
      }

      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.writeFile(absolutePath, parsed.content, 'utf-8')

      const newSha = createHash('sha256').update(parsed.content).digest('hex')
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
        summary: `Wrote ${rel}`,
        fileHashAfter: newSha
      }, null, 2)
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/write-tool.test.ts`
Expected: PASS（5 例全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/builtin/WriteTool.ts src/tests/write-tool.test.ts
git commit -m "feat(tools): add Write tool (full overwrite, requires prior Read for existing files)"
```
