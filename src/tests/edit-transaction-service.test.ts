import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'

vi.mock('electron', () => ({
  app: { getPath: () => process.cwd() }
}))

import { EditTransactionService } from '../main/services/EditTransactionService'
import { canonicalMutationPath } from '../main/tools/FileMutationCoordinator'
import { runWithTransactionLock } from '../main/tools/Tool'
import { EditTool } from '../main/tools/builtin/EditTool'
import { WriteTool } from '../main/tools/builtin/WriteTool'
import { NotebookEditTool } from '../main/tools/builtin/NotebookEditTool'
import { ReadTool } from '../main/tools/builtin/ReadTool'
import { getReadFingerprintStore } from '../main/tools/ReadFingerprintStore'

let root: string
let service: EditTransactionService

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

describe('EditTransactionService mutation safety', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'codez-edit-tx-'))
    service = new EditTransactionService()
    ;(service as any).backupRoot = path.join(root, 'backups')
  })

  afterEach(async () => {
    getReadFingerprintStore().clear('session-metadata-failure')
    await fs.rm(root, { recursive: true, force: true })
  })

  it('stores one original backup for aliases of the same physical file', async () => {
    const target = path.join(root, 'source.txt')
    const nested = path.join(root, 'nested')
    const alias = `${nested}${path.sep}..${path.sep}source.txt`
    await fs.mkdir(nested)
    await fs.writeFile(target, 'v1')
    const txId = await service.beginTransaction('session-alias')

    expect(await service.backupFile(txId, target, 'v1')).toBe(true)
    await fs.writeFile(target, 'v2')
    await service.recordMutationResult(txId, target, sha256('v2'))
    expect(await service.backupFile(txId, alias, 'v2')).toBe(false)
    expect(service.getTransaction(txId)?.backedUpFiles.size).toBe(1)

    await service.rollback(txId)
    expect(await fs.readFile(target, 'utf8')).toBe('v1')
  })

  it('retains a new-file entry when unlink fails with a non-ENOENT error', async () => {
    const target = path.join(root, 'cannot-unlink')
    const txId = await service.beginTransaction('session-failed-delete')
    await service.backupFile(txId, target, null)
    await fs.mkdir(target)

    await expect(service.rollback(txId)).rejects.toThrow('Rollback partially failed')
    expect(service.getTransaction(txId)?.backedUpFiles.has(canonicalMutationPath(target))).toBe(true)
    expect((await fs.stat(target)).isDirectory()).toBe(true)
  })

  it('returns false and retains the entry when rollbackFile cannot unlink it', async () => {
    const target = path.join(root, 'cannot-unlink-one')
    const txId = await service.beginTransaction('session-failed-single-delete')
    await service.backupFile(txId, target, null)
    await fs.mkdir(target)

    await expect(service.rollbackFile(txId, target)).resolves.toBe(false)
    expect(service.getTransaction(txId)?.backedUpFiles.has(canonicalMutationPath(target))).toBe(true)
  })

  it('treats an already absent new file as successfully rolled back', async () => {
    const target = path.join(root, 'already-absent.txt')
    const txId = await service.beginTransaction('session-absent')
    await service.backupFile(txId, target, null)

    await expect(service.rollback(txId)).resolves.toEqual([canonicalMutationPath(target)])
    expect(service.getTransaction(txId)).toBeUndefined()
  })

  it('waits for an in-flight transaction mutation before rolling back', async () => {
    const target = path.join(root, 'serialized.txt')
    await fs.writeFile(target, 'v1')
    const txId = await service.beginTransaction('session-serialized')
    const events: string[] = []
    let releaseMutation!: () => void
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve })
    let markMutationStarted!: () => void
    const mutationStarted = new Promise<void>((resolve) => { markMutationStarted = resolve })

    const mutation = runWithTransactionLock({
      workspaceRoot: root,
      transactionId: txId,
      editTransactionService: service
    }, async () => {
      events.push('mutation:start')
      await service.backupFile(txId, target, 'v1')
      markMutationStarted()
      await mutationGate
      await fs.writeFile(target, 'v2')
      await service.recordMutationResult(txId, target, sha256('v2'))
      events.push('mutation:end')
    })
    await mutationStarted
    const rollback = service.rollback(txId).then(() => { events.push('rollback:end') })

    await Promise.resolve()
    expect(events).toEqual(['mutation:start'])
    releaseMutation()
    await Promise.all([mutation, rollback])

    expect(events).toEqual(['mutation:start', 'mutation:end', 'rollback:end'])
    expect(await fs.readFile(target, 'utf8')).toBe('v1')
  })

  it('does not run a transaction operation aborted while waiting for the lock', async () => {
    const txId = await service.beginTransaction('session-aborted-queue')
    const controller = new AbortController()
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    let secondRan = false

    const first = runWithTransactionLock({
      workspaceRoot: root,
      transactionId: txId,
      editTransactionService: service
    }, async () => {
      markFirstStarted()
      await gate
    })
    await firstStarted
    const second = runWithTransactionLock({
      workspaceRoot: root,
      transactionId: txId,
      editTransactionService: service,
      abortSignal: controller.signal
    }, async () => {
      secondRan = true
    })

    controller.abort('executor stopped')
    await expect(second).rejects.toThrow('executor stopped')
    expect(secondRan).toBe(false)
    let thirdRan = false
    const third = runWithTransactionLock({
      workspaceRoot: root,
      transactionId: txId,
      editTransactionService: service
    }, async () => {
      thirdRan = true
    })
    await Promise.resolve()
    expect(thirdRan).toBe(false)
    releaseFirst()
    await Promise.all([first, third])
    expect(thirdRan).toBe(true)
  })

  it('refuses to replace a destination symlink introduced after the mutation', async () => {
    const workspace = path.join(root, 'workspace')
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codez-rollback-outside-'))
    const target = path.join(workspace, 'source.txt')
    const outsideTarget = path.join(outside, 'outside.txt')
    await fs.mkdir(workspace)
    await fs.writeFile(target, 'original')
    await fs.writeFile(outsideTarget, 'outside')
    const registeredTarget = canonicalMutationPath(target)
    const txId = await service.beginTransaction('session-target-link')
    await service.backupFile(txId, target, 'original')
    await service.recordMutationResult(txId, target, sha256('original'))
    await fs.rm(target)

    try {
      try {
        await fs.symlink(outsideTarget, target, 'file')
      } catch (error: any) {
        if (process.platform === 'win32' && error?.code === 'EPERM') return
        throw error
      }

      await expect(service.rollback(txId)).rejects.toThrow('Rollback partially failed')
      expect(await fs.readFile(outsideTarget, 'utf8')).toBe('outside')
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true)
      expect(service.getTransaction(txId)?.backedUpFiles.has(registeredTarget)).toBe(true)
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('refuses to restore through a parent symlink redirected outside', async () => {
    const workspace = path.join(root, 'redirected-parent')
    const displaced = path.join(root, 'original-parent')
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codez-parent-outside-'))
    const target = path.join(workspace, 'source.txt')
    const outsideTarget = path.join(outside, 'source.txt')
    await fs.mkdir(workspace)
    await fs.writeFile(target, 'original')
    const registeredTarget = canonicalMutationPath(target)
    const txId = await service.beginTransaction('session-parent-link')
    await service.backupFile(txId, target, 'original')
    await fs.rename(workspace, displaced)
    await fs.writeFile(outsideTarget, 'outside')
    await fs.symlink(outside, workspace, process.platform === 'win32' ? 'junction' : 'dir')

    try {
      await expect(service.rollback(txId)).rejects.toThrow('Rollback partially failed')
      expect(await fs.readFile(outsideTarget, 'utf8')).toBe('outside')
      expect(service.getTransaction(txId)?.backedUpFiles.has(registeredTarget)).toBe(true)
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('refuses to delete a new file through a parent symlink redirected outside', async () => {
    const workspace = path.join(root, 'redirected-new-parent')
    const displaced = path.join(root, 'original-new-parent')
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codez-new-parent-outside-'))
    const target = path.join(workspace, 'new.txt')
    const outsideTarget = path.join(outside, 'new.txt')
    await fs.mkdir(workspace)
    const registeredTarget = canonicalMutationPath(target)
    const txId = await service.beginTransaction('session-new-parent-link')
    await service.backupFile(txId, target, null)
    await fs.writeFile(target, 'created')
    await fs.rename(workspace, displaced)
    await fs.writeFile(outsideTarget, 'outside')
    await fs.symlink(outside, workspace, process.platform === 'win32' ? 'junction' : 'dir')

    try {
      await expect(service.rollback(txId)).rejects.toThrow('Rollback partially failed')
      expect(await fs.readFile(outsideTarget, 'utf8')).toBe('outside')
      expect(service.getTransaction(txId)?.backedUpFiles.has(registeredTarget)).toBe(true)
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('does not overwrite a user edit made after the recorded CodeZ mutation', async () => {
    const target = path.join(root, 'user-edited.txt')
    await fs.writeFile(target, 'v1')
    const txId = await service.beginTransaction('session-user-conflict')
    await service.backupFile(txId, target, 'v1')
    await fs.writeFile(target, 'v2-codez')
    await service.recordMutationResult(txId, target, sha256('v2-codez'))
    await fs.writeFile(target, 'v3-user')

    await expect(service.rollback(txId)).rejects.toThrow('Rollback conflict')
    expect(await fs.readFile(target, 'utf8')).toBe('v3-user')
    expect(service.getTransaction(txId)?.backedUpFiles.has(canonicalMutationPath(target))).toBe(true)
  })

  it('does not delete a new file replaced after the recorded CodeZ mutation', async () => {
    const target = path.join(root, 'new-user-edited.txt')
    const txId = await service.beginTransaction('session-new-user-conflict')
    await service.backupFile(txId, target, null)
    await fs.writeFile(target, 'created-by-codez')
    await service.recordMutationResult(txId, target, sha256('created-by-codez'))
    await fs.writeFile(target, 'replaced-by-user')

    await expect(service.rollbackFile(txId, target)).resolves.toBe(false)
    expect(await fs.readFile(target, 'utf8')).toBe('replaced-by-user')
  })

  it('restores the original executable mode with the file content', async () => {
    if (process.platform === 'win32') return
    const target = path.join(root, 'script.sh')
    await fs.writeFile(target, '#!/bin/sh\necho before\n', { mode: 0o755 })
    await fs.chmod(target, 0o755)
    const txId = await service.beginTransaction('session-mode')
    await service.backupFile(txId, target, '#!/bin/sh\necho before\n')
    await fs.writeFile(target, '#!/bin/sh\necho after\n')
    await fs.chmod(target, 0o644)
    await service.recordMutationResult(txId, target, sha256('#!/bin/sh\necho after\n'))

    await service.rollback(txId)

    expect(await fs.readFile(target, 'utf8')).toBe('#!/bin/sh\necho before\n')
    expect((await fs.stat(target)).mode & 0o777).toBe(0o755)
  })

  it('does not overwrite a user mode change made after the CodeZ mutation', async () => {
    if (process.platform === 'win32') return
    const target = path.join(root, 'mode-conflict.sh')
    await fs.writeFile(target, 'v1', { mode: 0o755 })
    await fs.chmod(target, 0o755)
    const txId = await service.beginTransaction('session-mode-conflict')
    await service.backupFile(txId, target, 'v1')
    await fs.writeFile(target, 'v2')
    await fs.chmod(target, 0o644)
    await service.recordMutationResult(txId, target, sha256('v2'))
    await fs.chmod(target, 0o600)

    await expect(service.rollback(txId)).rejects.toThrow('Rollback mode conflict')
    expect(await fs.readFile(target, 'utf8')).toBe('v2')
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600)
  })

  it('leaves a non-replayable tombstone when backup directory cleanup fails', async () => {
    const target = path.join(root, 'cleanup-failure.txt')
    await fs.writeFile(target, 'v1')
    const txId = await service.beginTransaction('session-cleanup-failure')
    await service.backupFile(txId, target, 'v1')
    await fs.writeFile(target, 'v2')
    await service.recordMutationResult(txId, target, sha256('v2'))
    vi.spyOn(service as any, 'cleanupTxDir').mockResolvedValue(undefined)

    await service.rollback(txId)
    await fs.writeFile(target, 'v3-user')

    const reloaded = new EditTransactionService()
    ;(reloaded as any).backupRoot = path.join(root, 'backups')
    await reloaded.revertTransactions('session-cleanup-failure', [txId])
    expect(await fs.readFile(target, 'utf8')).toBe('v3-user')
  })

  it('tracks an external multi-file mutation in the parent transaction', async () => {
    const existing = path.join(root, 'external-existing.txt')
    const created = path.join(root, 'external-created.txt')
    await fs.writeFile(existing, 'v1')
    const txId = await service.beginTransaction('session-external-mutation')

    await service.runExternalMutation(txId, [created, existing], async () => {
      await fs.writeFile(existing, 'v2')
      await fs.writeFile(created, 'new')
    })

    await service.rollback(txId)
    expect(await fs.readFile(existing, 'utf8')).toBe('v1')
    await expect(fs.access(created)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains and updates backups when an external mutation changes files before throwing', async () => {
    const target = path.join(root, 'external-partial.txt')
    await fs.writeFile(target, 'before')
    const txId = await service.beginTransaction('session-external-partial')

    await expect(service.runExternalMutation(txId, [target], async () => {
      await fs.writeFile(target, 'partial')
      throw new Error('engine failed')
    })).rejects.toThrow('engine failed')

    expect(service.getTransaction(txId)?.backedUpFiles.size).toBe(1)
    expect(service.getTransaction(txId)?.expectedPostMutationSha256.get(
      canonicalMutationPath(target)
    )).toBe(sha256('partial'))
    await service.rollback(txId)
    expect(await fs.readFile(target, 'utf8')).toBe('before')
  })

  it('discards a newly staged backup only when a failed external mutation changed nothing', async () => {
    const target = path.join(root, 'external-unchanged.txt')
    await fs.writeFile(target, 'before')
    const txId = await service.beginTransaction('session-external-unchanged')

    await expect(service.runExternalMutation(txId, [target], async () => {
      throw new Error('failed before mutation')
    })).rejects.toThrow('failed before mutation')

    expect(service.getTransaction(txId)?.backedUpFiles.size).toBe(0)
    expect(await fs.readFile(target, 'utf8')).toBe('before')
  })

  it('refuses an external mutation after a user changes an already tracked file', async () => {
    const target = path.join(root, 'external-user-change.txt')
    await fs.writeFile(target, 'v1')
    const txId = await service.beginTransaction('session-external-user-change')
    await service.backupFile(txId, target, 'v1')
    await fs.writeFile(target, 'v2-codez')
    await service.recordMutationResult(txId, target, sha256('v2-codez'))
    await fs.writeFile(target, 'v3-user')
    const operation = vi.fn(async () => fs.writeFile(target, 'v4-merge'))

    await expect(service.runExternalMutation(txId, [target], operation))
      .rejects.toThrow('External mutation conflict')

    expect(operation).not.toHaveBeenCalled()
    expect(await fs.readFile(target, 'utf8')).toBe('v3-user')
  })

  it('rejects relative suffix lookup and rolls back only exact absolute transaction paths', async () => {
    const rootFile = path.join(root, 'src', 'a.ts')
    const nestedFile = path.join(root, 'packages', 'x', 'src', 'a.ts')
    await fs.mkdir(path.dirname(rootFile), { recursive: true })
    await fs.mkdir(path.dirname(nestedFile), { recursive: true })
    await fs.writeFile(rootFile, 'root-v1')
    await fs.writeFile(nestedFile, 'nested-v1')
    const txId = await service.beginTransaction('session-exact-path')
    await service.backupFile(txId, nestedFile, 'nested-v1')
    await service.backupFile(txId, rootFile, 'root-v1')
    await fs.writeFile(nestedFile, 'nested-v2')
    await fs.writeFile(rootFile, 'root-v2')
    await service.recordMutationResult(txId, nestedFile, sha256('nested-v2'))
    await service.recordMutationResult(txId, rootFile, sha256('root-v2'))

    await expect(service.rollbackFile(txId, path.join('src', 'a.ts'))).resolves.toBe(false)
    await expect(service.rollbackFile(txId, rootFile)).resolves.toBe(true)
    expect(await fs.readFile(rootFile, 'utf8')).toBe('root-v1')
    expect(await fs.readFile(nestedFile, 'utf8')).toBe('nested-v2')
    await expect(service.rollbackFile(txId, nestedFile)).resolves.toBe(true)
    expect(await fs.readFile(nestedFile, 'utf8')).toBe('nested-v1')
  })

  it('refuses to revert a transaction through the wrong session identity', async () => {
    const target = path.join(root, 'wrong-session.txt')
    await fs.writeFile(target, 'before')
    const txId = await service.beginTransaction('owner-session')
    await service.backupFile(txId, target, 'before')
    await fs.writeFile(target, 'after')
    await service.recordMutationResult(txId, target, sha256('after'))

    await expect(service.revertTransactions('other-session', [txId]))
      .rejects.toThrow('does not belong')
    await expect(service.previewRevertTransactions('other-session', [txId]))
      .rejects.toThrow('does not belong')
    expect(await fs.readFile(target, 'utf8')).toBe('after')
  })

  it('refuses a session cleanup path outside the edit backup root', async () => {
    const outside = path.join(root, 'outside-cleanup')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'keep.txt'), 'keep')

    await expect(service.cleanupSession('../outside-cleanup')).rejects.toThrow(
      'Unsafe edit-backup session path'
    )
    expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('reverts committed transactions safely in reverse mutation order', async () => {
    const target = path.join(root, 'reverse-order.txt')
    await fs.writeFile(target, 'v1')
    const first = await service.beginTransaction('session-reverse-order')
    await service.backupFile(first, target, 'v1')
    await fs.writeFile(target, 'v2')
    await service.recordMutationResult(first, target, sha256('v2'))
    await service.commit(first)

    const second = await service.beginTransaction('session-reverse-order')
    await service.backupFile(second, target, 'v2')
    await fs.writeFile(target, 'v3')
    await service.recordMutationResult(second, target, sha256('v3'))
    await service.commit(second)

    await service.revertTransactions('session-reverse-order', [second, first])
    expect(await fs.readFile(target, 'utf8')).toBe('v1')
  })

  it('aborts the mutation and removes the staged backup when metadata persistence fails', async () => {
    const target = path.join(root, 'metadata-failure.txt')
    await fs.writeFile(target, 'before')
    const txId = await service.beginTransaction('session-metadata-failure')
    const txDir = path.join(root, 'backups', 'session-metadata-failure', txId)
    await fs.rm(path.join(txDir, 'metadata.json'), { force: true })
    await fs.mkdir(path.join(txDir, 'metadata.json'))
    await new ReadTool().execute(JSON.stringify({ files: [{ file_path: target }] }), {
      workspaceRoot: root,
      sessionId: 'session-metadata-failure'
    })

    const result = await new EditTool().execute(JSON.stringify({
      file_path: target,
      old_string: 'before',
      new_string: 'after'
    }), {
      workspaceRoot: root,
      sessionId: 'session-metadata-failure',
      transactionId: txId,
      editTransactionService: service
    })

    expect(result).toContain('Failed to backup file before writing')
    expect(await fs.readFile(target, 'utf8')).toBe('before')
    expect(service.getTransaction(txId)?.backedUpFiles.size).toBe(0)
    expect((await fs.readdir(txDir)).sort()).toEqual(['metadata.json'])
  })

  it.each(['Edit', 'Write', 'NotebookEdit'] as const)(
    'rejects %s when its parent path is redirected outside while waiting for the transaction lock',
    async (toolName) => {
      const workspace = path.join(root, `guard-${toolName}`)
      const parent = path.join(workspace, 'target-dir')
      const displaced = path.join(workspace, 'original-target-dir')
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), `codez-guard-${toolName}-`))
      await fs.mkdir(parent, { recursive: true })
      const sessionId = `session-guard-${toolName}`
      const txId = await service.beginTransaction(sessionId)
      let target: string
      let args: string
      let tool: EditTool | WriteTool | NotebookEditTool

      if (toolName === 'Edit') {
        target = path.join(parent, 'target.txt')
        await fs.writeFile(target, 'before')
        await fs.writeFile(path.join(outside, 'target.txt'), 'outside')
        await new ReadTool().execute(JSON.stringify({ files: [{ file_path: target }] }), {
          workspaceRoot: workspace,
          sessionId
        })
        args = JSON.stringify({ file_path: target, old_string: 'before', new_string: 'after' })
        tool = new EditTool()
      } else if (toolName === 'Write') {
        target = path.join(parent, 'created.txt')
        args = JSON.stringify({ file_path: target, content: 'created-by-codez' })
        tool = new WriteTool()
      } else {
        target = path.join(parent, 'n.ipynb')
        const notebook = JSON.stringify({
          cells: [{ cell_type: 'code', source: ['print(1)\n'], metadata: {}, outputs: [] }],
          metadata: {}, nbformat: 4, nbformat_minor: 5
        })
        await fs.writeFile(target, notebook)
        await fs.writeFile(path.join(outside, 'n.ipynb'), notebook)
        await new ReadTool().execute(JSON.stringify({ files: [{ file_path: target }] }), {
          workspaceRoot: workspace,
          sessionId
        })
        args = JSON.stringify({
          notebook_path: target,
          cell_id: 'cell-0',
          new_source: 'print(2)\n',
          edit_mode: 'replace'
        })
        tool = new NotebookEditTool()
      }

      let release!: () => void
      let markHeld!: () => void
      const held = new Promise<void>((resolve) => { markHeld = resolve })
      const blocker = service.runExclusive(txId, async () => {
        markHeld()
        await new Promise<void>((resolve) => { release = resolve })
      })
      await held
      const pending = tool.execute(args, {
        workspaceRoot: workspace,
        sessionId,
        transactionId: txId,
        editTransactionService: service
      })
      await Promise.resolve()
      await fs.rename(parent, displaced)
      try {
        await fs.symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error: any) {
        release()
        await blocker
        if (process.platform === 'win32' && error?.code === 'EPERM') return
        throw error
      }
      release()
      await blocker

      const result = await pending
      expect(result).toContain('path identity changed')
      if (toolName === 'Edit') {
        expect(await fs.readFile(path.join(outside, 'target.txt'), 'utf8')).toBe('outside')
      } else if (toolName === 'Write') {
        await expect(fs.access(path.join(outside, 'created.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        expect(await fs.readFile(path.join(outside, 'n.ipynb'), 'utf8')).toContain('print(1)')
      }
      await fs.rm(outside, { recursive: true, force: true })
    }
  )

  it('generates diffs for shell-special paths without shell interpretation', async () => {
    const name = process.platform === 'win32'
      ? '%CODEZ_DIFF_PATH%.txt'
      : 'quote"$(echo-not-run).txt'
    const target = path.join(root, name)
    await fs.writeFile(target, 'v1\n')
    const txId = await service.beginTransaction('session-diff-path')
    await service.backupFile(txId, target, 'v1\n')
    await fs.writeFile(target, 'v2\n')

    const diffs = await service.getDiff(txId)

    expect(diffs).toHaveLength(1)
    expect(diffs[0].diff).toContain('-v1')
    expect(diffs[0].diff).toContain('+v2')
  })
})
