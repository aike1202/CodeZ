// src/tests/write-tool.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createHash } from 'crypto'
import { WriteTool } from '../main/tools/builtin/WriteTool'
import { ReadTool } from '../main/tools/builtin/ReadTool'
import { getReadFingerprintStore } from '../main/tools/ReadFingerprintStore'
import type { EditTransactionService } from '../main/services/EditTransactionService'

class MemoryEditTransactionService implements Pick<EditTransactionService, 'backupFile' | 'getDiff'> {
  backedUp = new Set<string>()
  async backupFile(_txId: string, abs: string): Promise<boolean> {
    try { await fs.readFile(abs); this.backedUp.add(abs) } catch (e: any) { if (e.code === 'ENOENT') { this.backedUp.add(abs); return true } throw e }
    return true
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
  await new ReadTool().execute(JSON.stringify({ files: [{ file_path: fp }] }), { workspaceRoot: root, sessionId: SESSION })
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

  it('binds the write CAS to the initially validated SHA', async () => {
    const fp = path.join(root, 'cas.txt')
    await fs.writeFile(fp, 'v1')
    await readFirst(fp)
    const discardBackup = vi.fn(async () => true)
    const tx = {
      backupFile: async () => {
        await fs.writeFile(fp, 'v2')
        const v2 = await fs.readFile(fp)
        const sha = createHash('sha256').update(v2).digest('hex')
        getReadFingerprintStore().recordDelivery(SESSION, 'main', fp, sha)
        return true
      },
      discardBackup,
      getDiff: async () => []
    }

    const result = await new WriteTool().execute(JSON.stringify({ file_path: fp, content: 'agent' }), {
      workspaceRoot: root,
      sessionId: SESSION,
      transactionId: 'tx-cas',
      editTransactionService: tx as unknown as EditTransactionService
    })

    expect(result).toContain('changed after validation')
    expect(await fs.readFile(fp, 'utf-8')).toBe('v2')
    expect(discardBackup).toHaveBeenCalledWith('tx-cas', fp)
  })

  it('does not overwrite a file externally created after absence validation', async () => {
    const fp = path.join(root, 'race.txt')
    const discardBackup = vi.fn(async () => true)
    const tx = {
      backupFile: async () => {
        await fs.writeFile(fp, 'external')
        return true
      },
      discardBackup,
      getDiff: async () => []
    }

    const result = await new WriteTool().execute(JSON.stringify({ file_path: fp, content: 'agent' }), {
      workspaceRoot: root,
      sessionId: SESSION,
      transactionId: 'tx-create',
      editTransactionService: tx as unknown as EditTransactionService
    })

    expect(result).toContain('changed after validation')
    expect(await fs.readFile(fp, 'utf-8')).toBe('external')
    expect(discardBackup).toHaveBeenCalledWith('tx-create', fp)
  })

  it('does not create a file after cancellation is observed at the final commit point', async () => {
    const fp = path.join(root, 'aborted.txt')
    const controller = new AbortController()
    const discardBackup = vi.fn(async () => true)
    const tx = {
      backupFile: async () => {
        controller.abort('executor stopped')
        return true
      },
      discardBackup,
      getDiff: async () => []
    }

    const result = await new WriteTool().execute(JSON.stringify({ file_path: fp, content: 'agent' }), {
      workspaceRoot: root,
      sessionId: SESSION,
      transactionId: 'tx-aborted',
      editTransactionService: tx as unknown as EditTransactionService,
      abortSignal: controller.signal
    })

    expect(result).toContain('executor stopped')
    await expect(fs.access(fp)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(discardBackup).toHaveBeenCalledWith('tx-aborted', fp)
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

  it('拒绝通过 workspace 内链接在外部新建文件', async () => {
    const outside = path.join(os.tmpdir(), `outside-write-link-${Date.now()}`)
    await fs.mkdir(outside, { recursive: true })
    try {
      const link = path.join(root, 'external-link')
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      const target = path.join(link, 'created.txt')
      const result = await new WriteTool().execute(
        JSON.stringify({ file_path: target, content: 'denied' }),
        { workspaceRoot: root, sessionId: SESSION }
      )

      expect(result).toContain('Access denied')
      await expect(fs.access(path.join(outside, 'created.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('缺 content：返错', async () => {
    const tool = new WriteTool()
    const result = await tool.execute(JSON.stringify({ file_path: path.join(root, 'a.txt') }), { workspaceRoot: root, sessionId: SESSION })
    expect(result.startsWith('Error:')).toBe(true)
  })
})
