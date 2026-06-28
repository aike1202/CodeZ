import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'
import { app } from 'electron'

export interface TransactionState {
  id: string
  sessionId: string
  /** 原文件绝对路径 → 备份文件绝对路径 */
  backedUpFiles: Map<string, string>
  createdAt: number
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
  private backupRoot: string

  constructor() {
    this.backupRoot = path.join(app.getPath('userData'), 'edit-backups')
  }

  /** 开启一个新的修改事务 */
  async beginTransaction(sessionId: string): Promise<string> {
    const txId = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const txDir = path.join(this.backupRoot, sessionId, txId)

    await fs.mkdir(txDir, { recursive: true })

    this.transactions.set(txId, {
      id: txId,
      sessionId,
      backedUpFiles: new Map(),
      createdAt: Date.now()
    })

    return txId
  }


  /**
   * 在修改文件前调用：若该文件尚未在当前事务中备份过，
   * 将原文件内容拷贝到备份目录。
   */
  async backupFile(txId: string, absolutePath: string): Promise<void> {
    const tx = this.transactions.get(txId)
    if (!tx) {
      throw new Error(`No active transaction with id: ${txId}`)
    }

    // 已经备份过的文件不重复备份（只备份首次修改前的版本）
    if (tx.backedUpFiles.has(absolutePath)) {
      return
    }

    const txDir = path.join(
      this.backupRoot,
      tx.sessionId,
      txId
    )

    // 生成备份文件名：用原文件路径的 hash 避免冲突
    const safeName = absolutePath
      .replace(/[:\\\/]/g, '_')
      .replace(/\s/g, '_')
    const backupPath = path.join(txDir, safeName)

    try {
      // 只在原文件存在时备份（新建文件无需备份）
      await fs.access(absolutePath)
      await fs.copyFile(absolutePath, backupPath)
      tx.backedUpFiles.set(absolutePath, backupPath)
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        // 文件不存在（是新建的），记录为 null 标志以便回滚时删除
        tx.backedUpFiles.set(absolutePath, '')
      } else {
        throw err
      }
    }
  }

  /**
   * 单个文件回滚：将特定备份的文件恢复到原路径，从事务中移除该文件。
   */
  async rollbackFile(txId: string, absolutePath: string): Promise<boolean> {
    const tx = this.transactions.get(txId)
    if (!tx) return false

    const backupPath = tx.backedUpFiles.get(absolutePath)
    if (backupPath === undefined) return false

    try {
      if (backupPath === '') {
        try {
          await fs.unlink(absolutePath)
        } catch {}
      } else {
        await fs.copyFile(backupPath, absolutePath)
      }
      tx.backedUpFiles.delete(absolutePath)
      return true
    } catch (err: any) {
      console.error(`[EditTransaction] Failed to rollback file ${absolutePath}:`, err.message)
      return false
    }
  }

  /**
   * 单个文件提交：清理特定文件的备份，从事务中移除。
   */
  async commitFile(txId: string, absolutePath: string): Promise<boolean> {
    const tx = this.transactions.get(txId)
    if (!tx) return false

    const backupPath = tx.backedUpFiles.get(absolutePath)
    if (backupPath === undefined) return false

    tx.backedUpFiles.delete(absolutePath)
    if (backupPath !== '') {
      try {
        await fs.unlink(backupPath)
      } catch {}
    }
    return true
  }

  /**
   * 回滚整个事务：将所有备份的文件恢复到原路径。
   */
  async rollback(txId: string): Promise<string[]> {
    const tx = this.transactions.get(txId)
    if (!tx) {
      throw new Error(`No active transaction with id: ${txId}`)
    }

    const restoredFiles: string[] = []

    for (const [originalPath, backupPath] of tx.backedUpFiles) {
      try {
        if (backupPath === '') {
          // 新建文件：回滚意味着删除
          try {
            await fs.unlink(originalPath)
          } catch {
            // 文件可能已被手动删除，忽略
          }
        } else {
          // 已有文件：从备份恢复
          await fs.copyFile(backupPath, originalPath)
        }
        restoredFiles.push(originalPath)
      } catch (err: any) {
        // 单个文件回滚失败不中断整体流程
        console.error(`[EditTransaction] Failed to rollback ${originalPath}:`, err.message)
      }
    }

    // 清理备份目录
    await this.cleanupTxDir(txId, tx.sessionId)
    this.transactions.delete(txId)

    return restoredFiles
  }

  /**
   * 提交整个事务：清理备份目录，确认所有修改生效。
   */
  async commit(txId: string): Promise<void> {
    const tx = this.transactions.get(txId)
    if (!tx) return

    await this.cleanupTxDir(txId, tx.sessionId)
    this.transactions.delete(txId)
  }

  /**
   * 生成事务内所有修改文件的 Diff
   */
  async getDiff(txId: string): Promise<Array<{ path: string; diff: string }>> {
    const tx = this.transactions.get(txId)
    if (!tx) return []

    const { exec } = require('child_process')
    const { promisify } = require('util')
    const execAsync = promisify(exec)

    const diffs: Array<{ path: string; diff: string }> = []

    for (const [originalPath, backupPath] of tx.backedUpFiles) {
      try {
        let diffOutput = ''
        if (backupPath === '') {
          // Newly created file
          const cmd = process.platform === 'win32' 
            ? `git diff --no-index NUL "${originalPath}"` 
            : `git diff --no-index /dev/null "${originalPath}"`
          const result = await execAsync(cmd).catch((e: any) => e)
          diffOutput = result.stdout || ''
        } else {
          const result = await execAsync(`git diff --no-index "${backupPath}" "${originalPath}"`).catch((e: any) => e)
          diffOutput = result.stdout || ''
        }
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

  /** 清理指定事务的备份目录 */
  private async cleanupTxDir(txId: string, sessionId: string): Promise<void> {
    const txDir = path.join(
      this.backupRoot,
      sessionId,
      txId
    )

    try {
      await fs.rm(txDir, { recursive: true, force: true })

      // 尝试清理空的 session 目录
      const sessionDir = path.join(this.backupRoot, sessionId)
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

