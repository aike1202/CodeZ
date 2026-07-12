// src/tests/edit-tool.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { EditTool } from '../main/tools/builtin/EditTool'
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

  it('uses canonical path identity when attaching the transaction diff', async () => {
    const nested = path.join(root, 'nested')
    await fs.mkdir(nested)
    const fp = path.join(root, 'diff.txt')
    await fs.writeFile(fp, 'before')
    await readFirst(fp)
    const tx = {
      backupFile: vi.fn(async () => true),
      getDiff: vi.fn(async () => [{
        path: path.join(nested, '..', 'diff.txt'),
        diff: 'canonical diff'
      }])
    }

    const result = await new EditTool().execute(JSON.stringify({
      file_path: fp,
      old_string: 'before',
      new_string: 'after'
    }), {
      workspaceRoot: root,
      sessionId: SESSION,
      transactionId: 'tx-diff',
      editTransactionService: tx as unknown as EditTransactionService
    })

    expect(JSON.parse(result).diff).toBe('canonical diff')
  })

  it('不能借用另一个 Agent scope 的 Read 交付', async () => {
    const fp = path.join(root, 'scoped.txt')
    await fs.writeFile(fp, 'before')
    await new ReadTool().execute(JSON.stringify({ files: [{ file_path: fp }] }), {
      workspaceRoot: root,
      sessionId: SESSION,
      contextScopeId: 'subagent:research'
    })

    const result = await new EditTool().execute(
      JSON.stringify({ file_path: fp, old_string: 'before', new_string: 'after' }),
      {
        workspaceRoot: root,
        sessionId: SESSION,
        contextScopeId: 'subagent:executor'
      }
    )

    expect(result).toContain('current version')
    expect(await fs.readFile(fp, 'utf-8')).toBe('before')
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

  it('serializes concurrent edits to the same delivered file without losing changes', async () => {
    const fp = path.join(root, 'parallel.txt')
    await fs.writeFile(fp, 'alpha beta')
    await readFirst(fp)
    const tool = new EditTool()

    const [first, second] = await Promise.all([
      tool.execute(JSON.stringify({ file_path: fp, old_string: 'alpha', new_string: 'ALPHA' }), {
        workspaceRoot: root, sessionId: SESSION
      }),
      tool.execute(JSON.stringify({ file_path: fp, old_string: 'beta', new_string: 'BETA' }), {
        workspaceRoot: root, sessionId: SESSION
      })
    ])

    expect(first.startsWith('Error:')).toBe(false)
    expect(second.startsWith('Error:')).toBe(false)
    expect(await fs.readFile(fp, 'utf-8')).toBe('ALPHA BETA')
  })

  it('rejects an external modification during backup and discards the staged backup', async () => {
    const fp = path.join(root, 'external.txt')
    await fs.writeFile(fp, 'before')
    await readFirst(fp)
    const discardBackup = vi.fn(async () => true)
    const tx = {
      backupFile: async () => {
        await fs.writeFile(fp, 'external')
        return true
      },
      discardBackup,
      getDiff: async () => []
    }

    const result = await new EditTool().execute(JSON.stringify({
      file_path: fp, old_string: 'before', new_string: 'after'
    }), {
      workspaceRoot: root,
      sessionId: SESSION,
      transactionId: 'tx-stale',
      editTransactionService: tx as unknown as EditTransactionService
    })

    expect(result).toContain('changed after validation')
    expect(await fs.readFile(fp, 'utf-8')).toBe('external')
    expect(discardBackup).toHaveBeenCalledWith('tx-stale', fp)
  })

  it('does not write after cancellation is observed at the final commit point', async () => {
    const fp = path.join(root, 'aborted.txt')
    await fs.writeFile(fp, 'before')
    await readFirst(fp)
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

    const result = await new EditTool().execute(JSON.stringify({
      file_path: fp, old_string: 'before', new_string: 'after'
    }), {
      workspaceRoot: root,
      sessionId: SESSION,
      transactionId: 'tx-aborted',
      editTransactionService: tx as unknown as EditTransactionService,
      abortSignal: controller.signal
    })

    expect(result).toContain('executor stopped')
    expect(await fs.readFile(fp, 'utf-8')).toBe('before')
    expect(discardBackup).toHaveBeenCalledWith('tx-aborted', fp)
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

  it('拒绝通过 workspace 内链接修改外部文件', async () => {
    const outside = path.join(os.tmpdir(), `outside-edit-link-${Date.now()}`)
    await fs.mkdir(outside, { recursive: true })
    const outsideFile = path.join(outside, 'target.txt')
    await fs.writeFile(outsideFile, 'before')
    try {
      const link = path.join(root, 'external-link')
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      const linkedFile = path.join(link, 'target.txt')
      await readFirst(linkedFile)
      const result = await new EditTool().execute(
        JSON.stringify({ file_path: linkedFile, old_string: 'before', new_string: 'after' }),
        { workspaceRoot: root, sessionId: SESSION }
      )

      expect(result).toContain('Access denied')
      expect(await fs.readFile(outsideFile, 'utf-8')).toBe('before')
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('同一 workspace 内的路径别名共享 Read 授权并写入 canonical 文件', async () => {
    const realDir = path.join(root, 'real')
    const link = path.join(root, 'alias')
    await fs.mkdir(realDir)
    await fs.symlink(realDir, link, process.platform === 'win32' ? 'junction' : 'dir')
    const realFile = path.join(realDir, 'target.txt')
    const linkedFile = path.join(link, 'target.txt')
    await fs.writeFile(realFile, 'before')
    await readFirst(linkedFile)

    const result = await new EditTool().execute(
      JSON.stringify({ file_path: linkedFile, old_string: 'before', new_string: 'after' }),
      { workspaceRoot: root, sessionId: SESSION }
    )

    expect(result.startsWith('Error:')).toBe(false)
    expect(await fs.readFile(realFile, 'utf-8')).toBe('after')
  })
})
