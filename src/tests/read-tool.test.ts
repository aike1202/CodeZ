// src/tests/read-tool.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

const readArgs = (...files: Array<{ file_path: string; offset?: number; limit?: number }>): string =>
  JSON.stringify({ files })

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

  it('schema 只暴露必填 files 数组', () => {
    const schema = new ReadTool().parameters_schema as any
    expect(schema.required).toEqual(['files'])
    expect(schema.properties.file_path).toBeUndefined()
    expect(schema.properties.files.minItems).toBe(1)
    expect(schema.properties.files.maxItems).toBe(8)
  })

  it('描述要求批量已知目标并合并重叠范围', () => {
    const description = new ReadTool().description
    expect(description).toContain('Before calling Read, collect every file and range already known')
    expect(description).toContain('as few files arrays as the schema permits')
    expect(description).toContain('additional independent Read calls in the same response')
    expect(description).toContain('merge adjacent or overlapping ranges')
    expect(description).toContain('or when the next target depends on the current result')
    expect(description).toContain('After a file changes, re-read it without an arbitrary range')
  })

  it('描述要求首次读取省略任意行范围', () => {
    const description = new ReadTool().description
    expect(description).toContain('For an initial read without an evidence-based relevant range, omit offset and limit')
    expect(description).toContain('A known relevant range is permitted even on the first read')
    expect(description).toContain('Do not probe arbitrary first 50 or 100 lines')
    expect(description).toContain('marked truncated or reached its documented content-budget boundary')
    expect(description).toContain('A default text read returns up to 1,200 lines')
    const schema = new ReadTool().parameters_schema as any
    expect(schema.properties.files.items.properties.offset.description).toContain('Omit for an initial read without an evidence-based relevant range')
    expect(schema.properties.files.items.properties.limit.description).toContain('Omit for an initial read without an evidence-based relevant range')
  })

  it('首次读：返回带行号+SHA 的正文并写入指纹', async () => {
    const tool = new ReadTool()
    const result = await tool.execute(readArgs({ file_path: fp }), {
      workspaceRoot: root,
      sessionId: SESSION
    })
    expect(result).toContain('1\tline one')
    expect(result).toContain('2\tline two')
    expect(result).toMatch(/SHA256: [0-9a-f]{64}/)
    expect(getReadFingerprintStore().isUnchangedKnown(SESSION, fp)).toBe(true)
  })

  it('同 sha 再读：从共享快照回放正文', async () => {
    const tool = new ReadTool()
    await tool.execute(readArgs({ file_path: fp }), { workspaceRoot: root, sessionId: SESSION })
    const again = await tool.execute(readArgs({ file_path: fp }), { workspaceRoot: root, sessionId: SESSION })
    expect(again).not.toContain('Wasted call')
    expect(again).toContain('line one')
    expect(again).toContain('Source: shared-cache')
  })

  it('默认读后，range 读从同一共享快照返回目标正文', async () => {
    const tool = new ReadTool()
    await tool.execute(readArgs({ file_path: fp }), { workspaceRoot: root, sessionId: SESSION })
    const rangeResult = await tool.execute(readArgs({ file_path: fp, offset: 1, limit: 2 }), { workspaceRoot: root, sessionId: SESSION })
    expect(rangeResult).not.toContain('Wasted call')
    expect(rangeResult).toContain('line one')
    expect(rangeResult).toContain('Source: shared-cache')
  })

  it('内容改变后：返回新正文并更新指纹', async () => {
    const tool = new ReadTool()
    await tool.execute(readArgs({ file_path: fp }), { workspaceRoot: root, sessionId: SESSION })
    await fs.writeFile(fp, 'changed content\n')
    const result = await tool.execute(readArgs({ file_path: fp }), { workspaceRoot: root, sessionId: SESSION })
    expect(result).toContain('changed content')
    expect(result).not.toContain('Wasted call')
  })

  it('二进制文件：返回 Cannot read binary file.', async () => {
    const bin = path.join(root, 'b.bin')
    await fs.writeFile(bin, Buffer.from([0x00, 0x01, 0x02, 0x00]))
    const tool = new ReadTool()
    const result = await tool.execute(readArgs({ file_path: bin }), { workspaceRoot: root, sessionId: SESSION })
    expect(result).toContain('Cannot read binary file.')
  })

  it('workspace 外路径：拒绝', async () => {
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.txt`)
    await fs.writeFile(outside, 'x')
    try {
      const tool = new ReadTool()
      const result = await tool.execute(readArgs({ file_path: outside }), { workspaceRoot: root, sessionId: SESSION })
      expect(result).toContain('Error: Access denied. Cannot read file outside of workspace.')
    } finally {
      await fs.rm(outside, { force: true })
    }
  })

  it('缺 files：返错', async () => {
    const tool = new ReadTool()
    const result = await tool.execute(JSON.stringify({}), { workspaceRoot: root, sessionId: SESSION })
    expect(result.startsWith('Error:')).toBe(true)
  })

  it('拒绝旧的顶层 file_path 参数', async () => {
    const tool = new ReadTool()
    const result = await tool.execute(JSON.stringify({ file_path: fp }), { workspaceRoot: root, sessionId: SESSION })
    expect(result).toContain('Error: files is required')
  })

  it('即使提供 files 也拒绝额外的旧顶层参数', async () => {
    const tool = new ReadTool()
    const result = await tool.execute(
      JSON.stringify({ files: [{ file_path: fp }], file_path: fp }),
      { workspaceRoot: root, sessionId: SESSION }
    )
    expect(result).toContain('Error: Read only accepts the files parameter')
  })

  it('拒绝空 files 数组', async () => {
    const tool = new ReadTool()
    const result = await tool.execute(JSON.stringify({ files: [] }), { workspaceRoot: root, sessionId: SESSION })
    expect(result).toContain('Error: files must contain between 1 and 8 items')
  })

  it('拒绝超过八个文件', async () => {
    const tool = new ReadTool()
    const files = Array.from({ length: 9 }, (_, index) => ({ file_path: `file-${index}.txt` }))
    const result = await tool.execute(JSON.stringify({ files }), { workspaceRoot: root, sessionId: SESSION })
    expect(result).toContain('Error: files must contain between 1 and 8 items')
  })

  it('批量读取多个文件并保持输入顺序', async () => {
    const second = path.join(root, 'b.txt')
    await fs.writeFile(second, 'second file\n')
    const tool = new ReadTool()

    const result = await tool.execute(
      readArgs({ file_path: second }, { file_path: fp }),
      { workspaceRoot: root, sessionId: SESSION }
    )

    expect(result.indexOf(`path="${second}"`)).toBeLessThan(result.indexOf(`path="${fp}"`))
    expect(result).toContain('second file')
    expect(result).toContain('line one')
  })

  it('整批读取共享总字符预算', async () => {
    const files = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
      const filePath = path.join(root, `large-${index}.txt`)
      await fs.writeFile(filePath, `${String(index)}-${'x'.repeat(10_000)}`)
      return { file_path: filePath }
    }))

    const result = await new ReadTool().execute(readArgs(...files), {
      workspaceRoot: root,
      sessionId: SESSION
    })

    expect(result.length).toBeLessThan(30_000)
    expect(result).toContain('shared Read batch budget')
  })

  it('单个文件失败时仍返回其他文件', async () => {
    const missing = path.join(root, 'missing.txt')
    const tool = new ReadTool()

    const result = await tool.execute(
      readArgs({ file_path: missing }, { file_path: fp }),
      { workspaceRoot: root, sessionId: SESSION }
    )

    expect(result).toContain('Error: File not found.')
    expect(result).toContain('line one')
  })

  it('offset/limit 切片：只返回指定行', async () => {
    const tool = new ReadTool()
    const result = await tool.execute(readArgs({ file_path: fp, offset: 2, limit: 1 }), { workspaceRoot: root, sessionId: SESSION })
    expect(result).toContain('2\tline two')
    expect(result).not.toContain('line one')
    expect(result).not.toContain('line three')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
})
