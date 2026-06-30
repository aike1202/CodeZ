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

  it('默认读命中指纹后，range 读（offset/limit）应返回正文而非 Wasted call（裁剪后逃逸口）', async () => {
    const tool = new ReadTool()
    await tool.execute(JSON.stringify({ file_path: fp }), { workspaceRoot: root, sessionId: SESSION })
    const rangeResult = await tool.execute(JSON.stringify({ file_path: fp, offset: 1, limit: 2 }), { workspaceRoot: root, sessionId: SESSION })
    expect(rangeResult).not.toContain('Wasted call')
    expect(rangeResult).toContain('line one')
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
