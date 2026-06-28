import { describe, it, expect } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createHash } from 'crypto'
import { ApplyPatchTool } from '../main/tools/builtin/ApplyPatchTool'
import type { EditTransactionService } from '../main/services/EditTransactionService'

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function setupWorkspace(): Promise<string> {
  const root = path.join(os.tmpdir(), `codez-apply-patch-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(root, { recursive: true })
  return root
}

class MemoryEditTransactionService implements Pick<EditTransactionService, 'backupFile' | 'getDiff'> {
  backedUpFiles = new Map<string, string>()
  originalContent = new Map<string, string>()

  async backupFile(_txId: string, absolutePath: string): Promise<void> {
    if (this.backedUpFiles.has(absolutePath)) return
    try {
      const content = await fs.readFile(absolutePath, 'utf-8')
      this.originalContent.set(absolutePath, content)
      this.backedUpFiles.set(absolutePath, 'backup')
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        this.backedUpFiles.set(absolutePath, '')
        return
      }
      throw err
    }
  }

  async getDiff(_txId: string): Promise<Array<{ path: string; diff: string }>> {
    const diffs: Array<{ path: string; diff: string }> = []
    for (const [filePath, backupMarker] of this.backedUpFiles) {
      const current = await fs.readFile(filePath, 'utf-8').catch(() => '')
      const original = backupMarker === '' ? '' : this.originalContent.get(filePath) || ''
      diffs.push({
        path: filePath,
        diff: `--- before\n+++ after\n-${original}\n+${current}`
      })
    }
    return diffs
  }
}

describe('ApplyPatchTool', () => {
  it('应要求已有文件必须提供 expectedHash', async () => {
    const root = await setupWorkspace()
    try {
      await fs.writeFile(path.join(root, 'file.txt'), 'hello world')
      const tool = new ApplyPatchTool()
      const result = await tool.execute(JSON.stringify({
        filePath: 'file.txt',
        edits: [{ targetContent: 'hello', replacementContent: 'hi' }]
      }), { workspaceRoot: root })

      expect(result).toContain('Error: expectedHash is missing')
      expect(await fs.readFile(path.join(root, 'file.txt'), 'utf-8')).toBe('hello world')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('hash 不匹配时应拒绝写入', async () => {
    const root = await setupWorkspace()
    try {
      await fs.writeFile(path.join(root, 'file.txt'), 'hello world')
      const tool = new ApplyPatchTool()
      const result = await tool.execute(JSON.stringify({
        filePath: 'file.txt',
        expectedHash: sha256('old content'),
        edits: [{ targetContent: 'hello', replacementContent: 'hi' }]
      }), { workspaceRoot: root })

      expect(result).toContain('Error: Hash mismatch')
      expect(await fs.readFile(path.join(root, 'file.txt'), 'utf-8')).toBe('hello world')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('targetContent 找不到或不唯一时应失败', async () => {
    const root = await setupWorkspace()
    try {
      const filePath = path.join(root, 'file.txt')
      await fs.writeFile(filePath, 'hello hello')
      const hash = sha256('hello hello')
      const tool = new ApplyPatchTool()

      const notFound = await tool.execute(JSON.stringify({
        filePath: 'file.txt',
        expectedHash: hash,
        edits: [{ targetContent: 'missing', replacementContent: 'x' }]
      }), { workspaceRoot: root })
      expect(notFound).toContain('targetContent not found')

      const notUnique = await tool.execute(JSON.stringify({
        filePath: 'file.txt',
        expectedHash: hash,
        edits: [{ targetContent: 'hello', replacementContent: 'x' }]
      }), { workspaceRoot: root })
      expect(notUnique).toContain('targetContent is not unique')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('成功修改已有文件时应返回 changedFiles/diff/summary/hash', async () => {
    const root = await setupWorkspace()
    try {
      const filePath = path.join(root, 'file.txt')
      await fs.writeFile(filePath, 'hello world')
      const tx = new MemoryEditTransactionService()
      const tool = new ApplyPatchTool()

      const result = await tool.execute(JSON.stringify({
        filePath: 'file.txt',
        expectedHash: sha256('hello world'),
        edits: [{ targetContent: 'hello', replacementContent: 'hi' }]
      }), {
        workspaceRoot: root,
        transactionId: 'tx_test',
        editTransactionService: tx as unknown as EditTransactionService
      })

      const parsed = JSON.parse(result)
      expect(parsed.changedFiles).toEqual(['file.txt'])
      expect(parsed.summary).toContain('Modified file.txt')
      expect(parsed.diff).toContain('hi world')
      expect(parsed.fileHashBefore).toBe(sha256('hello world'))
      expect(parsed.fileHashAfter).toBe(sha256('hi world'))
      expect(await fs.readFile(filePath, 'utf-8')).toBe('hi world')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('新建文件应进入事务记录并返回结构化结果', async () => {
    const root = await setupWorkspace()
    try {
      const tx = new MemoryEditTransactionService()
      const tool = new ApplyPatchTool()

      const result = await tool.execute(JSON.stringify({
        filePath: 'new-file.txt',
        fullOverwrite: true,
        newContent: 'created content'
      }), {
        workspaceRoot: root,
        transactionId: 'tx_test',
        editTransactionService: tx as unknown as EditTransactionService
      })

      const parsed = JSON.parse(result)
      expect(parsed.changedFiles).toEqual(['new-file.txt'])
      expect(parsed.summary).toContain('Created new-file.txt')
      expect(parsed.fileHashBefore).toBeUndefined()
      expect(parsed.fileHashAfter).toBe(sha256('created content'))
      expect(tx.backedUpFiles.get(path.join(root, 'new-file.txt'))).toBe('')
      expect(await fs.readFile(path.join(root, 'new-file.txt'), 'utf-8')).toBe('created content')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
