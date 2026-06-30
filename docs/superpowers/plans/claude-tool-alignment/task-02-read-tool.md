### Task 2: Read 工具（含哈希去重 + 二进制/预算/cat-n）

**Files:**
- Create: `src/main/tools/builtin/ReadTool.ts`
- Test: `src/tests/read-tool.test.ts`

**Interfaces:**
- Consumes: `Tool`/`ToolContext`（`src/main/tools/Tool.ts`）；`ReadFingerprintStore` + `getReadFingerprintStore()`（Task 1）。
- Produces: `class ReadTool extends Tool`，`name='Read'`，`parameters_schema={file_path(req), limit?, offset?, pages?}`，`execute(args, ctx): Promise<string>`。返回 **纯文本**：`N\t<line>` 行 + 末尾 `SHA256: <h>`；命中去重返回固定串 `Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.`；错误以 `Error: ...` 开头。
- 后续依赖：Task 3（Edit）/Task 4（Write）依赖 Read 写入的指纹记录（`isUnchangedKnown`）；Task 7 会在本工具中追加 `.ipynb` 特化分支。

**说明：** `file_path` 接受绝对路径或相对 workspace 的路径（相对时 `path.resolve(workspaceRoot, file_path)`）；做 workspace 前缀校验（大小写不敏感、`\\`→`/`）。预算沿用 `ReadFilesTool` 常量：`maxTotalLines=1200`、`maxTotalBytes=120000`、`maxCharsPerFile=40000`。`pages` 在 schema 保留但本期忽略 PDF，命中二进制返 `Cannot read binary file.`。

- [ ] **Step 1: Write the failing test**

```ts
// src/tests/read-tool.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { ReadTool } from '../main/tools/builtin/ReadTool'
import { getReadFingerprintStore } from '../main/tools/ReadFingerprintStore'

async function setupWorkspace(): Promise<string> {
  const root = path.join(os.tmpdir(), `codez-read-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(root, { recursive: true })
  return root
}

describe('ReadTool', () => {
  let root: string
  let fp: string
  const SESSION = 'sess-read'

  beforeEach(async () => {
    root = await setupWorkspace()
    fp = path.join(root, 'a.txt')
    await fs.writeFile(fp, 'line one\nline two\nline three\n')
    getReadFingerprintStore().clear(SESSION)
  })

  it('首次读：返回带行号+SHA 的正文并写入指纹', async () => {
    const tool = new ReadTool()
    const result = await tool.execute(JSON.stringify({ file_path: fp }), {
      workspaceRoot: root,
      sessionId: SESSION
    })
    expect(result).toContain('1\tline one')
    expect(result).toContain('2\tline two')
    expect(result).toMatch(/SHA256: [0-9a-f]{64}/)
    expect(getReadFingerprintStore().isUnchangedKnown(SESSION, fp)).toBe(true)
  })

  it('同 sha 再读：返回 Wasted call 且不含正文', async () => {
    const tool = new ReadTool()
    await tool.execute(JSON.stringify({ file_path: fp }), { workspaceRoot: root, sessionId: SESSION })
    const again = await tool.execute(JSON.stringify({ file_path: fp }), { workspaceRoot: root, sessionId: SESSION })
    expect(again).toContain('Wasted call — file unchanged')
    expect(again).not.toContain('line one')
  })

  it('内容改变后：返回新正文并更新指纹', async () => {
    const tool = new ReadTool()
    await tool.execute(JSON.stringify({ file_path: fp }), { workspaceRoot: root, sessionId: SESSION })
    await fs.writeFile(fp, 'changed content\n')
    const result = await tool.execute(JSON.stringify({ file_path: fp }), { workspaceRoot: root, sessionId: SESSION })
    expect(result).toContain('changed content')
    expect(result).not.toContain('Wasted call')
  })

  it('二进制文件：返回 Cannot read binary file.', async () => {
    const bin = path.join(root, 'b.bin')
    await fs.writeFile(bin, Buffer.from([0x00, 0x01, 0x02, 0x00]))
    const tool = new ReadTool()
    const result = await tool.execute(JSON.stringify({ file_path: bin }), { workspaceRoot: root, sessionId: SESSION })
    expect(result).toContain('Cannot read binary file.')
  })

  it('workspace 外路径：拒绝', async () => {
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.txt`)
    await fs.writeFile(outside, 'x')
    try {
      const tool = new ReadTool()
      const result = await tool.execute(JSON.stringify({ file_path: outside }), { workspaceRoot: root, sessionId: SESSION })
      expect(result.startsWith('Error:')).toBe(true)
    } finally {
      await fs.rm(outside, { force: true })
    }
  })

  it('缺 file_path：返错', async () => {
    const tool = new ReadTool()
    const result = await tool.execute(JSON.stringify({}), { workspaceRoot: root, sessionId: SESSION })
    expect(result.startsWith('Error:')).toBe(true)
  })

  it('offset/limit 切片：只返回指定行', async () => {
    const tool = new ReadTool()
    const result = await tool.execute(JSON.stringify({ file_path: fp, offset: 2, limit: 1 }), { workspaceRoot: root, sessionId: SESSION })
    expect(result).toContain('2\tline two')
    expect(result).not.toContain('line one')
    expect(result).not.toContain('line three')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/read-tool.test.ts`
Expected: FAIL，`Cannot find module '../main/tools/builtin/ReadTool'`。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/tools/builtin/ReadTool.ts
import { Tool, ToolContext } from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { getReadFingerprintStore } from '../ReadFingerprintStore'

interface ReadArgs {
  file_path?: string
  offset?: number
  limit?: number
  pages?: string
}

const MAX_TOTAL_LINES = 1200
const MAX_TOTAL_BYTES = 120000
const MAX_CHARS_PER_FILE = 40000
const MAX_FILE_BYTES = 5 * 1024 * 1024

export class ReadTool extends Tool {
  get name() {
    return 'Read'
  }

  get description() {
    return 'Reads a file from the local filesystem. file_path is absolute (or relative to workspace). Returns content in cat -n format (line numbers starting at 1). When you already know which part you need, use offset/limit to read only that part. Do NOT re-read a file you just edited or one whose content has not changed — a repeated Read of an unchanged file returns "Wasted call" and no content. Binary files return "Cannot read binary file."; images/PDFs are not supported this period. Reading a directory, missing file, or empty file returns an error.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute (or workspace-relative) path of the file to read.' },
        offset: { type: 'number', description: '1-indexed line to start reading from. Default 1.' },
        limit: { type: 'number', description: 'Maximum number of lines to return. Default up to budget.' },
        pages: { type: 'string', description: 'Reserved for PDF pages; not implemented this period (ignored).' }
      },
      required: ['file_path']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as ReadArgs
      if (!parsed.file_path) return 'Error: file_path is required.'

      const absolutePath = path.isAbsolute(parsed.file_path)
        ? parsed.file_path
        : path.resolve(context.workspaceRoot, parsed.file_path)
      const normalizedTarget = absolutePath.replace(/\\/g, '/').toLowerCase()
      const normalizedRoot = context.workspaceRoot.replace(/\\/g, '/').toLowerCase()
      if (!normalizedTarget.startsWith(normalizedRoot)) {
        return 'Error: Access denied. Cannot read file outside of workspace.'
      }

      const stat = await fs.stat(absolutePath).catch((e: any) => { throw e })
      if (!stat.isFile()) return 'Error: Not a file.'
      if (stat.size > MAX_FILE_BYTES) {
        return `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max 5MB.`
      }

      const buffer = await fs.readFile(absolutePath)
      if (buffer.subarray(0, 512).includes(0)) {
        return 'Cannot read binary file.'
      }

      const sha = createHash('sha256').update(buffer).digest('hex')
      const sessionId = context.sessionId
      if (sessionId) {
        const store = getReadFingerprintStore()
        if (store.isUnchanged(sessionId, absolutePath, sha)) {
          return 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.'
        }
      }

      const fullContent = buffer.toString('utf-8')
      const lines = fullContent.split('\n')
      const totalLines = lines.length

      const offset = parsed.offset && parsed.offset > 0 ? parsed.offset : 1
      const sliceStart = offset - 1
      let limit = parsed.limit && parsed.limit > 0 ? parsed.limit : MAX_TOTAL_LINES
      let selected = lines.slice(sliceStart, sliceStart + limit)

      let truncated = false
      if (selected.length > MAX_TOTAL_LINES) {
        selected = selected.slice(0, MAX_TOTAL_LINES)
        truncated = true
      }

      const numbered = selected.map((line, i) => `${offset + i}\t${line}`)
      let text = numbered.join('\n')

      if (text.length > MAX_CHARS_PER_FILE) {
        text = text.slice(0, MAX_CHARS_PER_FILE) +
          '\n\n[System Note: Content truncated due to maxCharsPerFile limit. Use offset/limit to paginate.]'
        truncated = true
      }
      const byteLen = Buffer.byteLength(text, 'utf-8')
      if (byteLen > MAX_TOTAL_BYTES) {
        text = Buffer.from(text, 'utf-8').subarray(0, MAX_TOTAL_BYTES).toString('utf-8') +
          '\n\n[System Note: Content truncated due to maxTotalBytes budget. Use offset/limit to paginate.]'
        truncated = true
      }

      if (sessionId) getReadFingerprintStore().record(sessionId, absolutePath, sha)

      const note = truncated ? `\n[truncated: ${totalLines} total lines]` : ''
      return `${text}${note}\n\nSHA256: ${sha}`
    } catch (err: any) {
      if (err.code === 'ENOENT') return 'Error: File not found.'
      return `Error: ${err.message}`
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/read-tool.test.ts`
Expected: PASS（7 例全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/builtin/ReadTool.ts src/tests/read-tool.test.ts
git commit -m "feat(tools): add Read tool with hash-based dedup and cat-n output"
```
