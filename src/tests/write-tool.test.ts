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
