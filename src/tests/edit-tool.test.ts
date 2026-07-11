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
  await new ReadTool().execute(JSON.stringify({ files: [{ file_path: fp }] }), { workspaceRoot: root, sessionId: SESSION })
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
