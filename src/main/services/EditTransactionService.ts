import * as fs from 'fs/promises'
import { constants as fsConstants } from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  canonicalMutationPath,
  getFileMutationCoordinator
} from '../tools/FileMutationCoordinator'
import { atomicWriteJson } from './context/atomicFile'

const execFileAsync = promisify(execFile)

export interface TransactionState {
  id: string
  sessionId: string
  /** 原文件绝对路径 → 备份文件绝对路径 */
  backedUpFiles: Map<string, string>
  /** Registered path -> SHA256 CodeZ most recently wrote, or null when it should be absent. */
  expectedPostMutationSha256: Map<string, string | null>
  /** Registered path -> mode CodeZ most recently left, or null when it should be absent. */
  expectedPostMutationModes: Map<string, number | null>
  /** Registered path -> original POSIX/Windows mode bits. */
  originalFileModes: Map<string, number>
  createdAt: number
}

interface MutationFileState {
  sha256: string | null
  mode: number | null
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  return new Error(
    typeof reason === 'string' && reason.trim()
      ? reason
      : 'Edit transaction was aborted while waiting for its lock.'
  )
}

async function waitForPrevious(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await previous.catch(() => undefined)
    return
  }
  if (signal.aborted) throw abortError(signal)
  let onAbort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([previous.catch(() => undefined), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 跨文件修改事务管理服务。
 *
 * 在 Agent 执行文件修改操作前自动备份原文件，
 * 支持一键回滚所有修改或正常提交（清理备份）。
 *
 * 备份存储在 Electron userData 目录下，不污染用户 workspace。
 */
export class EditTransactionService {
  private transactions: Map<string, TransactionState> = new Map()
  private metadataQueues: Map<string, Promise<void>> = new Map()
  private transactionQueues: Map<string, Promise<void>> = new Map()
  private closingSessions = new Set<string>()
  private backupRoot: string

  constructor() {
    this.backupRoot = path.join(app.getPath('userData'), 'edit-backups')
  }

  private backupDirectory(sessionId: string, txId?: string): string {
    const assertSegment = (value: string, label: string) => {
      if (!value || value === '.' || value === '..' || /[\\/\0]/.test(value)) {
        throw new Error(`Unsafe edit-backup ${label} path: ${value}`)
      }
    }
    assertSegment(sessionId, 'session')
    if (txId !== undefined) assertSegment(txId, 'transaction')
    const root = path.resolve(this.backupRoot)
    const target = txId === undefined
      ? path.resolve(root, sessionId)
      : path.resolve(root, sessionId, txId)
    const relative = path.relative(root, target)
    if (
      relative === '' || relative === '..' ||
      relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ) {
      throw new Error(`Unsafe edit-backup path: ${sessionId}${txId ? `/${txId}` : ''}`)
    }
    return target
  }

  /** Serializes mutations and rollback operations that belong to one transaction. */
  async runExclusive<T>(
    txId: string,
    operation: () => Promise<T>,
    abortSignal?: AbortSignal,
    allowClosing = false
  ): Promise<T> {
    const previous = this.transactionQueues.get(txId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const queued = previous.catch(() => undefined).then(() => current)
    this.transactionQueues.set(txId, queued)

    try {
      await waitForPrevious(previous, abortSignal)
      if (abortSignal?.aborted) throw abortError(abortSignal)
      const tx = this.transactions.get(txId)
      if (!allowClosing && tx && this.closingSessions.has(tx.sessionId)) {
        throw new Error(`Session ${tx.sessionId} is closing; edit transaction work is no longer accepted.`)
      }
      return await operation()
    } finally {
      release()
      void queued.then(() => {
        if (this.transactionQueues.get(txId) === queued) this.transactionQueues.delete(txId)
      })
    }
  }

  private async saveMetadata(txId: string): Promise<void> {
    const previous = this.metadataQueues.get(txId) || Promise.resolve()
    const pending = previous.catch(() => undefined).then(async () => {
      const tx = this.transactions.get(txId)
      if (!tx) return
      const txDir = path.join(this.backupRoot, tx.sessionId, txId)
      const metadataPath = path.join(txDir, 'metadata.json')
      const data = {
        id: tx.id,
        sessionId: tx.sessionId,
        backedUpFiles: Array.from(tx.backedUpFiles.entries()),
        expectedPostMutationSha256: Array.from(tx.expectedPostMutationSha256.entries()),
        expectedPostMutationModes: Array.from(tx.expectedPostMutationModes.entries()),
        originalFileModes: Array.from(tx.originalFileModes.entries()),
        createdAt: tx.createdAt
      }
      await atomicWriteJson(metadataPath, data)
    })
    this.metadataQueues.set(txId, pending)
    try {
      await pending
    } finally {
      if (this.metadataQueues.get(txId) === pending) this.metadataQueues.delete(txId)
    }
  }

  /** 开启一个新的修改事务 */
  async beginTransaction(sessionId: string): Promise<string> {
    if (this.closingSessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} is closing; cannot begin an edit transaction.`)
    }
    const txId = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const txDir = this.backupDirectory(sessionId, txId)

    await fs.mkdir(txDir, { recursive: true })

    this.transactions.set(txId, {
      id: txId,
      sessionId,
      backedUpFiles: new Map(),
      expectedPostMutationSha256: new Map(),
      expectedPostMutationModes: new Map(),
      originalFileModes: new Map(),
      createdAt: Date.now()
    })

    try {
      await this.saveMetadata(txId)
    } catch (error) {
      this.transactions.delete(txId)
      this.metadataQueues.delete(txId)
      await fs.rm(txDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }

    return txId
  }


  /**
   * 在修改文件前调用：若该文件尚未在当前事务中备份过，
   * 将原文件内容拷贝到备份目录。
   */
  async backupFile(
    txId: string,
    absolutePath: string,
    originalContent?: string | Buffer | null
  ): Promise<boolean> {
    const tx = this.transactions.get(txId)
    if (!tx) {
      throw new Error(`No active transaction with id: ${txId}`)
    }

    const canonicalPath = canonicalMutationPath(absolutePath)

    // 已经备份过的物理文件不重复备份（只备份首次修改前的版本）
    if (tx.backedUpFiles.has(canonicalPath)) {
      return false
    }

    const txDir = path.join(
      this.backupRoot,
      tx.sessionId,
      txId
    )

    const safeName = createHash('sha256').update(canonicalPath).digest('hex')
    const backupPath = path.join(txDir, safeName)

    let stagedBackupPath = ''
    try {
      if (originalContent === null) {
        tx.backedUpFiles.set(canonicalPath, '')
        tx.expectedPostMutationSha256.set(canonicalPath, null)
        tx.expectedPostMutationModes.set(canonicalPath, null)
      } else if (originalContent !== undefined) {
        const originalBuffer = Buffer.isBuffer(originalContent)
          ? originalContent
          : Buffer.from(originalContent, 'utf8')
        const stat = await fs.stat(canonicalPath)
        stagedBackupPath = backupPath
        await fs.writeFile(backupPath, originalBuffer, { mode: stat.mode & 0o7777 })
        tx.backedUpFiles.set(canonicalPath, backupPath)
        tx.expectedPostMutationSha256.set(
          canonicalPath,
          createHash('sha256').update(originalBuffer).digest('hex')
        )
        tx.expectedPostMutationModes.set(canonicalPath, stat.mode & 0o7777)
        tx.originalFileModes.set(canonicalPath, stat.mode & 0o7777)
      } else {
        await fs.access(canonicalPath)
        const stat = await fs.stat(canonicalPath)
        stagedBackupPath = backupPath
        await fs.copyFile(canonicalPath, backupPath)
        const originalBuffer = await fs.readFile(backupPath)
        tx.backedUpFiles.set(canonicalPath, backupPath)
        tx.expectedPostMutationSha256.set(
          canonicalPath,
          createHash('sha256').update(originalBuffer).digest('hex')
        )
        tx.expectedPostMutationModes.set(canonicalPath, stat.mode & 0o7777)
        tx.originalFileModes.set(canonicalPath, stat.mode & 0o7777)
      }
      await this.saveMetadata(txId)
      return true
    } catch (err: any) {
      if (originalContent === undefined && err?.code === 'ENOENT' && !stagedBackupPath) {
        try {
          tx.backedUpFiles.set(canonicalPath, '')
          tx.expectedPostMutationSha256.set(canonicalPath, null)
          tx.expectedPostMutationModes.set(canonicalPath, null)
          await this.saveMetadata(txId)
          return true
        } catch (metadataError) {
          tx.backedUpFiles.delete(canonicalPath)
          tx.expectedPostMutationSha256.delete(canonicalPath)
          tx.expectedPostMutationModes.delete(canonicalPath)
          tx.originalFileModes.delete(canonicalPath)
          throw metadataError
        }
      }
      tx.backedUpFiles.delete(canonicalPath)
      tx.expectedPostMutationSha256.delete(canonicalPath)
      tx.expectedPostMutationModes.delete(canonicalPath)
      tx.originalFileModes.delete(canonicalPath)
      if (stagedBackupPath) {
        await fs.rm(stagedBackupPath, { force: true }).catch(() => undefined)
      }
      throw err
    }
  }

  /** Removes a newly staged backup when the guarded write never happened. */
  async discardBackup(txId: string, absolutePath: string): Promise<boolean> {
    const tx = this.transactions.get(txId)
    if (!tx) return false
    const key = this.findBackedUpKey(tx, absolutePath)
    if (!key) return false
    const backupPath = tx.backedUpFiles.get(key) || ''
    const expectedSha = tx.expectedPostMutationSha256.get(key)
    const expectedMode = tx.expectedPostMutationModes.get(key)
    const originalMode = tx.originalFileModes.get(key)
    tx.backedUpFiles.delete(key)
    tx.expectedPostMutationSha256.delete(key)
    tx.expectedPostMutationModes.delete(key)
    tx.originalFileModes.delete(key)
    try {
      await this.saveMetadata(txId)
    } catch (error) {
      tx.backedUpFiles.set(key, backupPath)
      if (expectedSha !== undefined) tx.expectedPostMutationSha256.set(key, expectedSha)
      if (expectedMode !== undefined) tx.expectedPostMutationModes.set(key, expectedMode)
      if (originalMode !== undefined) tx.originalFileModes.set(key, originalMode)
      throw error
    }
    if (backupPath) await fs.rm(backupPath, { force: true }).catch(() => undefined)
    return true
  }

  /** Persists the exact file state that a later rollback is allowed to replace. */
  async recordMutationResult(
    txId: string,
    absolutePath: string,
    sha256: string | null
  ): Promise<void> {
    if (sha256 !== null && !/^[0-9a-f]{64}$/i.test(sha256)) {
      throw new Error('Mutation result SHA256 is invalid')
    }
    const tx = this.transactions.get(txId)
    if (!tx) throw new Error(`No active transaction with id: ${txId}`)
    const key = this.findBackedUpKey(tx, absolutePath)
    if (!key) throw new Error(`No transaction backup exists for: ${absolutePath}`)
    let mode: number | null = null
    if (sha256 !== null) {
      const stat = await fs.lstat(key)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Mutation result is no longer a regular file: ${key}`)
      }
      mode = stat.mode & 0o7777
    }
    tx.expectedPostMutationSha256.set(key, sha256?.toLowerCase() ?? null)
    tx.expectedPostMutationModes.set(key, mode)
    // Keep the in-memory CAS even if persistence fails; the filesystem mutation
    // has already happened and must remain rollback-safe in this process.
    await this.saveMetadata(txId)
  }

  /**
   * Tracks a multi-file mutation performed by an external engine such as Git.
   * The caller supplies the exact workspace paths that engine may change.
   */
  async runExternalMutation<T>(
    txId: string,
    absolutePaths: readonly string[],
    operation: () => Promise<T> | T,
    abortSignal?: AbortSignal
  ): Promise<T> {
    return this.runExclusive(txId, async () => {
      const tx = this.transactions.get(txId)
      if (!tx) throw new Error(`No active transaction with id: ${txId}`)
      const paths = [...new Set(absolutePaths.map((value) => canonicalMutationPath(value)))].sort()
      const coordinator = getFileMutationCoordinator()

      const withFileLocks = async (index: number): Promise<T> => {
        if (index < paths.length) {
          return coordinator.run(
            paths[index],
            () => withFileLocks(index + 1),
            abortSignal
          )
        }

        const staged: string[] = []
        const beforeStates = new Map<string, MutationFileState>()
        try {
          for (const filePath of paths) {
            const newlyStaged = await this.backupFile(txId, filePath)
            if (newlyStaged) staged.push(filePath)
            const beforeState = await this.currentFileState(filePath)
            beforeStates.set(filePath, beforeState)
            if (!newlyStaged) {
              const expectedState: MutationFileState | undefined =
                tx.expectedPostMutationSha256.has(filePath) &&
                tx.expectedPostMutationModes.has(filePath)
                  ? {
                      sha256: tx.expectedPostMutationSha256.get(filePath) ?? null,
                      mode: tx.expectedPostMutationModes.get(filePath) ?? null
                    }
                  : undefined
              if (!this.sameMutationState(expectedState, beforeState)) {
                throw new Error(
                  `External mutation conflict for ${filePath}: the file changed after CodeZ ` +
                  'recorded its previous transaction state.'
                )
              }
            }
          }
          if (abortSignal?.aborted) throw abortError(abortSignal)
          const result = await operation()
          const afterStates = new Map<string, MutationFileState>()
          for (const filePath of paths) {
            afterStates.set(filePath, await this.currentFileState(filePath))
          }
          await this.recordMutationStates(txId, afterStates)
          return result
        } catch (error) {
          let afterStates: Map<string, MutationFileState> | undefined
          let trackingError: unknown
          try {
            afterStates = new Map<string, MutationFileState>()
            for (const filePath of paths) {
              afterStates.set(filePath, await this.currentFileState(filePath))
            }
          } catch (stateError) {
            trackingError = stateError
          }

          const unchanged = afterStates && paths.every((filePath) =>
            this.sameMutationState(beforeStates.get(filePath), afterStates!.get(filePath))
          )
          if (unchanged) {
            for (const filePath of staged.reverse()) {
              await this.discardBackup(txId, filePath)
            }
          } else if (afterStates) {
            try {
              await this.recordMutationStates(txId, afterStates)
            } catch (stateError) {
              trackingError = stateError
            }
          }

          if (trackingError) {
            throw new AggregateError(
              [error, trackingError],
              `External mutation failed and its resulting state could not be fully journaled: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          }
          throw error
        }
      }

      return withFileLocks(0)
    }, abortSignal)
  }

  private findBackedUpKey(tx: TransactionState, requestPath: string): string | undefined {
    if (!path.isAbsolute(requestPath)) return undefined
    const canonicalPath = canonicalMutationPath(requestPath)
    if (tx.backedUpFiles.has(canonicalPath)) {
      return canonicalPath
    }
    const normalizedRequest = this.normalizePathIdentity(requestPath)
    const matches = [...tx.backedUpFiles.keys()].filter((key) =>
      path.isAbsolute(key) && this.normalizePathIdentity(key) === normalizedRequest
    )
    return matches.length === 1 ? matches[0] : undefined
  }

  private sameMutationState(
    left: MutationFileState | undefined,
    right: MutationFileState | undefined
  ): boolean {
    return Boolean(left && right) && left!.sha256 === right!.sha256 && left!.mode === right!.mode
  }

  private async recordMutationStates(
    txId: string,
    states: ReadonlyMap<string, MutationFileState>
  ): Promise<void> {
    const tx = this.transactions.get(txId)
    if (!tx) throw new Error(`No active transaction with id: ${txId}`)
    const updates: Array<{ key: string; state: MutationFileState }> = []
    for (const [filePath, state] of states) {
      const key = this.findBackedUpKey(tx, filePath)
      if (!key) throw new Error(`No transaction backup exists for: ${filePath}`)
      if (state.sha256 !== null && !/^[0-9a-f]{64}$/i.test(state.sha256)) {
        throw new Error(`Mutation result SHA256 is invalid for: ${filePath}`)
      }
      if ((state.sha256 === null) !== (state.mode === null)) {
        throw new Error(`Mutation result mode does not match file state for: ${filePath}`)
      }
      updates.push({ key, state })
    }
    for (const { key, state } of updates) {
      tx.expectedPostMutationSha256.set(key, state.sha256?.toLowerCase() ?? null)
      tx.expectedPostMutationModes.set(key, state.mode)
    }
    await this.saveMetadata(txId)
  }

  private normalizePathIdentity(value: string): string {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  /**
   * A transaction key is canonicalized when the backup is registered. Refuse to
   * replay it if the containing directory now resolves somewhere else.
   */
  private async validateRegisteredParent(
    registeredPath: string,
    allowAlreadyMissing: boolean
  ): Promise<boolean> {
    if (!path.isAbsolute(registeredPath)) {
      throw new Error(`Unsafe rollback path is not absolute: ${registeredPath}`)
    }

    const registeredParent = path.dirname(registeredPath)
    let actualParent: string
    try {
      actualParent = await fs.realpath(registeredParent)
    } catch (error: any) {
      if (allowAlreadyMissing && error?.code === 'ENOENT') {
        const targetMissing = await fs.lstat(registeredPath)
          .then(() => false)
          .catch((statError: any) => {
            if (statError?.code === 'ENOENT') return true
            throw statError
          })
        if (targetMissing) return false
      }
      throw error
    }

    if (
      this.normalizePathIdentity(actualParent) !==
      this.normalizePathIdentity(registeredParent)
    ) {
      throw new Error(
        `Rollback parent identity changed for ${registeredPath}: ` +
        `expected ${registeredParent}, resolved ${actualParent}`
      )
    }
    return true
  }

  private rollbackTempPath(registeredPath: string): string {
    return path.join(
      path.dirname(registeredPath),
      `.codez-rollback-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
    )
  }

  private async currentFileState(registeredPath: string): Promise<MutationFileState> {
    let before: Awaited<ReturnType<typeof fs.lstat>>
    try {
      before = await fs.lstat(registeredPath)
    } catch (error: any) {
      if (error?.code === 'ENOENT') return { sha256: null, mode: null }
      throw error
    }
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`Rollback target is no longer a regular file: ${registeredPath}`)
    }
    const content = await fs.readFile(registeredPath)
    const after = await fs.lstat(registeredPath)
    if (
      !after.isFile() || after.isSymbolicLink() ||
      before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      (before.mode & 0o7777) !== (after.mode & 0o7777)
    ) {
      throw new Error(`Rollback target changed while it was being verified: ${registeredPath}`)
    }
    return {
      sha256: createHash('sha256').update(content).digest('hex'),
      mode: after.mode & 0o7777
    }
  }

  private async currentFileSha256(registeredPath: string): Promise<string | null> {
    return (await this.currentFileState(registeredPath)).sha256
  }

  private async assertExpectedMutationState(
    registeredPath: string,
    expectedSha256: string | null | undefined,
    expectedMode: number | null | undefined
  ): Promise<void> {
    if (expectedSha256 === undefined) {
      throw new Error(
        `Rollback cannot verify legacy transaction state for ${registeredPath}; ` +
        'refusing to overwrite a possibly newer user edit.'
      )
    }
    const currentSha256 = await this.currentFileSha256(registeredPath)
    if (currentSha256 !== expectedSha256) {
      throw new Error(
        `Rollback conflict for ${registeredPath}: expected ` +
        `${expectedSha256 ?? 'the file to be absent'}, found ${currentSha256 ?? 'an absent file'}.`
      )
    }
    if (expectedSha256 !== null) {
      if (expectedMode === undefined || expectedMode === null) {
        throw new Error(`Rollback cannot verify the expected file mode for ${registeredPath}.`)
      }
      const currentMode = (await fs.lstat(registeredPath)).mode & 0o7777
      if (currentMode !== (expectedMode & 0o7777)) {
        throw new Error(
          `Rollback mode conflict for ${registeredPath}: expected ` +
          `${(expectedMode & 0o7777).toString(8)}, found ${currentMode.toString(8)}.`
        )
      }
    }
  }

  private async restoreBackupAtomically(
    registeredPath: string,
    backupPath: string,
    expectedSha256: string | null | undefined,
    expectedMode: number | null | undefined,
    originalMode?: number
  ): Promise<void> {
    await this.validateRegisteredParent(registeredPath, false)
    await this.assertExpectedMutationState(registeredPath, expectedSha256, expectedMode)
    const tempPath = this.rollbackTempPath(registeredPath)
    try {
      await fs.copyFile(backupPath, tempPath, fsConstants.COPYFILE_EXCL)
      if (originalMode !== undefined) await fs.chmod(tempPath, originalMode)
      // Narrow parent-swap races that happen while the backup is copied.
      await this.validateRegisteredParent(registeredPath, false)
      await this.assertExpectedMutationState(registeredPath, expectedSha256, expectedMode)
      await fs.rename(tempPath, registeredPath)
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
    }
  }

  private async removeCreatedFile(
    registeredPath: string,
    expectedSha256: string | null | undefined,
    expectedMode: number | null | undefined
  ): Promise<void> {
    const parentAvailable = await this.validateRegisteredParent(registeredPath, true)
    if (!parentAvailable) return
    await this.assertExpectedMutationState(registeredPath, expectedSha256, expectedMode)
    try {
      // unlink removes the directory entry itself and never follows a final symlink.
      await fs.unlink(registeredPath)
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  private async restoreTransactionEntry(
    registeredPath: string,
    backupPath: string,
    expectedSha256: string | null | undefined,
    expectedMode: number | null | undefined,
    originalMode?: number
  ): Promise<void> {
    await this.validateRegisteredParent(registeredPath, backupPath === '')
    const originalSha256 = backupPath
      ? createHash('sha256').update(await fs.readFile(backupPath)).digest('hex')
      : null
    const currentSha256 = await this.currentFileSha256(registeredPath)
    if (currentSha256 === originalSha256) {
      if (originalSha256 === null || originalMode === undefined) return
      const currentMode = (await fs.lstat(registeredPath)).mode
      if ((currentMode & 0o7777) === (originalMode & 0o7777)) return
    }
    if (backupPath === '') {
      await this.removeCreatedFile(registeredPath, expectedSha256, expectedMode)
      return
    }
    await this.restoreBackupAtomically(
      registeredPath,
      backupPath,
      expectedSha256,
      expectedMode,
      originalMode
    )
  }

  /**
   * 单个文件回滚：将特定备份的文件恢复到原路径，从事务中移除该文件。
   */
  async rollbackFile(txId: string, absolutePath: string): Promise<boolean> {
    return this.runExclusive(txId, async () => {
      const tx = this.transactions.get(txId)
      if (!tx) return false

      const key = this.findBackedUpKey(tx, absolutePath)
      if (!key) return false
      const backupPath = tx.backedUpFiles.get(key)!
      const expectedSha = tx.expectedPostMutationSha256.get(key)
      const expectedMode = tx.expectedPostMutationModes.get(key)
      const originalMode = tx.originalFileModes.get(key)

      const restored = await getFileMutationCoordinator().run(key, async () => {
        try {
          await this.restoreTransactionEntry(
            key,
            backupPath,
            expectedSha,
            expectedMode,
            originalMode
          )
          return true
        } catch (err: any) {
          console.error(`[EditTransaction] Failed to rollback file ${key}:`, err.message)
          return false
        }
      })
      if (!restored) return false

      tx.backedUpFiles.delete(key)
      tx.expectedPostMutationSha256.delete(key)
      tx.expectedPostMutationModes.delete(key)
      tx.originalFileModes.delete(key)
      try {
        await this.saveMetadata(txId)
      } catch (error) {
        tx.backedUpFiles.set(key, backupPath)
        tx.expectedPostMutationSha256.set(
          key,
          backupPath
            ? createHash('sha256').update(await fs.readFile(backupPath)).digest('hex')
            : null
        )
        tx.expectedPostMutationModes.set(
          key,
          backupPath && originalMode !== undefined ? originalMode : null
        )
        if (originalMode !== undefined) tx.originalFileModes.set(key, originalMode)
        throw error
      }
      if (backupPath) await fs.rm(backupPath, { force: true }).catch(() => undefined)
      return true
    })
  }

  /**
   * 单个文件提交：目前保留备份，仅标记为已接受
   */
  async commitFile(txId: string, absolutePath: string): Promise<boolean> {
    const tx = this.transactions.get(txId)
    if (!tx) return false

    const key = this.findBackedUpKey(tx, absolutePath)
    if (!key) return false
    
    // We no longer delete the backup file here so that history is retained.
    return true
  }

  /**
   * 回滚整个事务：将所有备份的文件恢复到原路径。
   */
  async rollback(txId: string): Promise<string[]> {
    return this.runExclusive(txId, async () => {
      const tx = this.transactions.get(txId)
      if (!tx) {
        throw new Error(`No active transaction with id: ${txId}`)
      }

      const restoredFiles: string[] = []
      const failures: Array<{ path: string; message: string }> = []

      for (const [originalPath, backupPath] of [...tx.backedUpFiles]) {
        await getFileMutationCoordinator().run(originalPath, async () => {
          try {
            await this.restoreTransactionEntry(
              originalPath,
              backupPath,
              tx.expectedPostMutationSha256.get(originalPath),
              tx.expectedPostMutationModes.get(originalPath),
              tx.originalFileModes.get(originalPath)
            )
            restoredFiles.push(originalPath)
            tx.backedUpFiles.delete(originalPath)
            tx.expectedPostMutationSha256.delete(originalPath)
            tx.expectedPostMutationModes.delete(originalPath)
            tx.originalFileModes.delete(originalPath)
          } catch (err: any) {
            const message = err?.message || String(err)
            failures.push({ path: originalPath, message })
            console.error(`[EditTransaction] Failed to rollback ${originalPath}:`, message)
          }
        })
      }

      if (tx.backedUpFiles.size === 0) {
        // Persist an empty tombstone before best-effort cleanup so a failed rm
        // cannot leave replayable rollback entries on disk.
        await this.saveMetadata(txId)
        await this.cleanupTxDir(txId, tx.sessionId)
        this.transactions.delete(txId)
        this.metadataQueues.delete(txId)
      } else {
        await this.saveMetadata(txId)
      }

      if (failures.length > 0) {
        const details = failures.map((failure) => `${failure.path}: ${failure.message}`).join('; ')
        throw new Error(
          `Rollback partially failed after restoring ${restoredFiles.length} file(s). ` +
          `Failed entries were retained for retry: ${details}`
        )
      }

      return restoredFiles
    })
  }

  /**
   * 提交整个事务：保留备份以便历史回退，仅从内存中移除。
   */
  async commit(txId: string): Promise<void> {
    await this.runExclusive(txId, async () => {
      const tx = this.transactions.get(txId)
      if (!tx) return

      // We no longer cleanup the txDir here to retain history for reverting
      this.transactions.delete(txId)
      this.metadataQueues.delete(txId)
    })
  }

  /**
   * 批量回滚指定的一系列事务（用于 Revert Message）
   * 必须按时间倒序传入 txIds
   */
  async revertTransactions(sessionId: string, txIds: string[]): Promise<void> {
    for (const txId of txIds) {
      await this.loadTransactionForSession(sessionId, txId)
      await this.rollback(txId)
    }
  }

  /**
   * 预览批量回滚会影响哪些文件
   */
  async previewRevertTransactions(sessionId: string, txIds: string[]): Promise<{ toDelete: string[], toRestore: string[] }> {
    const toDelete = new Set<string>()
    const toRestore = new Set<string>()

    for (const txId of txIds) {
      const tx = await this.loadTransactionForSession(sessionId, txId)
      for (const [originalPath, backupPath] of tx.backedUpFiles) {
        if (backupPath === '') {
          toDelete.add(originalPath)
        } else {
          // If it's already marked for delete in a newer tx, we still restore it if it existed originally
          toRestore.add(originalPath)
          toDelete.delete(originalPath)
        }
      }
    }
    return { toDelete: Array.from(toDelete), toRestore: Array.from(toRestore) }
  }

  /**
   * 彻底清理某个会话的所有文件备份历史
   */
  async cleanupSession(sessionId: string): Promise<void> {
    const sessionDir = this.backupDirectory(sessionId)
    this.closingSessions.add(sessionId)
    try {
      const txIds = [...this.transactions.values()]
        .filter((tx) => tx.sessionId === sessionId)
        .map((tx) => tx.id)
      await Promise.all(txIds.map((txId) =>
        this.runExclusive(txId, async () => undefined, undefined, true)
      ))
      await Promise.all(txIds.map((txId) =>
        (this.metadataQueues.get(txId) || Promise.resolve()).catch(() => undefined)
      ))
      await fs.rm(sessionDir, { recursive: true, force: true })
      for (const txId of txIds) {
        this.transactions.delete(txId)
        this.metadataQueues.delete(txId)
        this.transactionQueues.delete(txId)
      }
    } finally {
      this.closingSessions.delete(sessionId)
    }
  }

  /**
   * 生成事务内所有修改文件的 Diff
   */
  async getDiff(txId: string): Promise<Array<{ path: string; diff: string }>> {
    const tx = this.transactions.get(txId)
    if (!tx) return []

    const diffs: Array<{ path: string; diff: string }> = []

    for (const [originalPath, backupPath] of tx.backedUpFiles) {
      try {
        let diffOutput = ''
        const basePath = backupPath || (process.platform === 'win32' ? 'NUL' : '/dev/null')
        const result = await execFileAsync(
          'git',
          ['diff', '--no-index', basePath, originalPath],
          { maxBuffer: 10 * 1024 * 1024 }
        ).catch((error: any) => error)
        diffOutput = result.stdout || ''
        diffs.push({ path: originalPath, diff: diffOutput })
      } catch (err: any) {
        console.error(`[EditTransaction] Failed to generate diff for ${originalPath}:`, err.message)
      }
    }

    return diffs
  }

  /** 获取指定事务 */
  getTransaction(txId: string): TransactionState | undefined {
    return this.transactions.get(txId)
  }

  private async loadTransactionForSession(
    sessionId: string,
    txId: string
  ): Promise<TransactionState> {
    const existing = this.transactions.get(txId)
    if (existing) {
      if (existing.sessionId !== sessionId) {
        throw new Error(`Transaction ${txId} does not belong to session ${sessionId}`)
      }
      return existing
    }

    const txDir = this.backupDirectory(sessionId, txId)
    const metadataPath = path.join(txDir, 'metadata.json')
    let data: any
    try {
      data = JSON.parse(await fs.readFile(metadataPath, 'utf8'))
    } catch (error) {
      throw new Error(`Transaction backup is unavailable for ${txId}`, { cause: error })
    }
    if (data?.id !== txId || data?.sessionId !== sessionId) {
      throw new Error(`Transaction metadata identity mismatch for ${txId}`)
    }
    if (!Array.isArray(data.backedUpFiles)) {
      throw new Error(`Transaction metadata is invalid for ${txId}`)
    }
    const backedUpFiles = new Map<string, string>()
    for (const entry of data.backedUpFiles) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new Error(`Transaction backup entry is invalid for ${txId}`)
      }
      const [registeredPath, backupPath] = entry
      if (typeof registeredPath !== 'string' || !path.isAbsolute(registeredPath)) {
        throw new Error(`Transaction path is unsafe for ${txId}`)
      }
      if (typeof backupPath !== 'string') {
        throw new Error(`Transaction backup path is invalid for ${txId}`)
      }
      if (backupPath) {
        const resolvedBackup = path.resolve(backupPath)
        const relative = path.relative(txDir, resolvedBackup)
        if (
          relative === '' || relative === '..' ||
          relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        ) {
          throw new Error(`Transaction backup path escapes its directory for ${txId}`)
        }
      }
      backedUpFiles.set(registeredPath, backupPath)
    }
    const tx: TransactionState = {
      id: txId,
      sessionId,
      backedUpFiles,
      expectedPostMutationSha256: new Map(data.expectedPostMutationSha256 || []),
      expectedPostMutationModes: new Map(data.expectedPostMutationModes || []),
      originalFileModes: new Map(data.originalFileModes || []),
      createdAt: Number(data.createdAt) || Date.now()
    }
    this.transactions.set(txId, tx)
    return tx
  }

  /** 清理指定事务的备份目录 */
  private async cleanupTxDir(txId: string, sessionId: string): Promise<void> {
    const txDir = this.backupDirectory(sessionId, txId)

    try {
      await fs.rm(txDir, { recursive: true, force: true })

      // 尝试清理空的 session 目录
      const sessionDir = this.backupDirectory(sessionId)
      const remaining = await fs.readdir(sessionDir)
      if (remaining.length === 0) {
        await fs.rmdir(sessionDir)
      }
    } catch {
      // 清理失败不影响主流程
    }
  }
}

let instance: EditTransactionService | null = null

export function getEditTransactionService(): EditTransactionService {
  if (!instance) {
    instance = new EditTransactionService()
  }
  return instance
}
