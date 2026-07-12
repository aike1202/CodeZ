// src/main/tools/builtin/WriteTool.ts
import {
  discardStagedBackup,
  recordTransactionMutation,
  runWithTransactionLock,
  throwIfToolAborted,
  Tool,
  ToolContext,
  type ToolExecutionOutput
} from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { getReadFingerprintStore, readStatSignature } from '../ReadFingerprintStore'
import { canonicalMutationPath, getFileMutationCoordinator } from '../FileMutationCoordinator'
import {
  analyzePathImpactSync,
  assertStableWorkspacePathSync
} from '../../services/permission/PathImpactAnalyzer'

interface WriteArgs {
  file_path?: string
  content?: string
}

export class WriteTool extends Tool {
  get name() {
    return 'Write'
  }

  get summary() {
    return 'Write or overwrite a file.'
  }

  get description() {
    return 'Writes a file to the local filesystem, overwriting if one exists. Use to create a new file, or to fully replace one you have already Read in this conversation. Overwriting an existing file you have NOT Read fails — use Edit for partial changes instead. Writes go through the edit transaction and can be rolled back with rollback_last_edit.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute (or workspace-relative) path of the file to write.' },
        content: { type: 'string', description: 'The full new content of the file.' }
      },
      required: ['file_path', 'content']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as WriteArgs
      if (!parsed.file_path) return 'Error: file_path is required.'
      if (typeof parsed.content !== 'string') return 'Error: content is required.'
      const filePath = parsed.file_path
      const content = parsed.content

      const requestedPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(context.workspaceRoot, filePath)
      const pathImpact = analyzePathImpactSync(requestedPath, context.workspaceRoot)
      if (!pathImpact.insideWorkspace || path.resolve(requestedPath) === path.resolve(context.workspaceRoot)) {
        return 'Error: Access denied. Cannot modify file outside of workspace.'
      }
      const absolutePath = pathImpact.resolvedPath

      return await runWithTransactionLock(context, () =>
        getFileMutationCoordinator().run(absolutePath, async () => {
        assertStableWorkspacePathSync(requestedPath, context.workspaceRoot, absolutePath)
        await fs.mkdir(path.dirname(absolutePath), { recursive: true })
        assertStableWorkspacePathSync(requestedPath, context.workspaceRoot, absolutePath)
        const sessionId = context.sessionId
        const contextScopeId = context.contextScopeId ?? context.runtimeTurn?.contextScopeId ?? 'main'
        const exists = await fs.access(absolutePath).then(() => true).catch(() => false)
        let original: Buffer | undefined
        let expectedSha: string | undefined
        if (exists) {
          original = await fs.readFile(absolutePath)
          expectedSha = createHash('sha256').update(original).digest('hex')
          if (
            !sessionId ||
            !getReadFingerprintStore().hasDelivery(
              sessionId,
              contextScopeId,
              absolutePath,
              expectedSha
            )
          ) {
            return 'Error: You must Read this file in this conversation before overwriting it. Use Edit for partial changes.'
          }
        }

        let stagedBackup = false
        if (context.editTransactionService && context.transactionId) {
          try {
            stagedBackup = await context.editTransactionService.backupFile(
              context.transactionId,
              absolutePath,
              original ?? null
            )
          } catch (e: any) {
            return `Error: Failed to backup file before writing: ${e.message}`
          }
        }

        const latestExists = await fs.access(absolutePath).then(() => true).catch(() => false)
        let stale = latestExists !== exists
        if (exists && latestExists) {
          const latest = await fs.readFile(absolutePath)
          stale = createHash('sha256').update(latest).digest('hex') !== expectedSha
        }
        if (stale) {
          await discardStagedBackup(context, absolutePath, stagedBackup)
          return 'Error: File changed after validation. Re-Read the current version before writing.'
        }

        try {
          throwIfToolAborted(context.abortSignal)
          assertStableWorkspacePathSync(requestedPath, context.workspaceRoot, absolutePath)
        } catch (error) {
          await discardStagedBackup(context, absolutePath, stagedBackup)
          throw error
        }
        try {
          await fs.writeFile(
            absolutePath,
            content,
            exists ? { encoding: 'utf-8' } : { encoding: 'utf-8', flag: 'wx' }
          )
        } catch (error: any) {
          if (!exists && error?.code === 'EEXIST') {
            await discardStagedBackup(context, absolutePath, stagedBackup)
            return 'Error: File was created after validation. Read it before overwriting.'
          }
          throw error
        }

        const newSha = createHash('sha256').update(content).digest('hex')
        await recordTransactionMutation(context, absolutePath, newSha)
        if (sessionId) {
          const nextStat = await fs.stat(absolutePath)
          const store = getReadFingerprintStore()
          store.recordSnapshot(sessionId, absolutePath, {
            sha256: newSha,
            buffer: Buffer.from(content, 'utf-8'),
            statSignature: readStatSignature(nextStat)
          })
          store.recordDelivery(sessionId, contextScopeId, absolutePath, newSha)
        }

        let diff = ''
        if (context.editTransactionService && context.transactionId) {
          try {
            const diffs = await context.editTransactionService.getDiff(context.transactionId)
            const canonicalPath = canonicalMutationPath(absolutePath)
            diff = diffs.find((item) => canonicalMutationPath(item.path) === canonicalPath)?.diff || ''
          } catch { diff = '' }
        }
        const rel = path.relative(context.workspaceRoot, requestedPath)
        return JSON.stringify({
          changedFiles: [rel],
          diff,
          summary: `Wrote ${rel}`,
          fileHashAfter: newSha
        }, null, 2)
        }, context.abortSignal)
      )
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }

  override async executeWithMetadata(
    args: string,
    context: ToolContext
  ): Promise<ToolExecutionOutput> {
    const uiContent = await this.execute(args, context)
    if (uiContent.startsWith('Error:')) return { content: uiContent }
    try {
      const input = JSON.parse(args) as WriteArgs
      const result = JSON.parse(uiContent) as { summary?: string; fileHashAfter?: string }
      if (!input.file_path || !result.fileHashAfter) return { content: uiContent }
      const absolutePath = analyzePathImpactSync(input.file_path, context.workspaceRoot).resolvedPath
      return {
        content: `${result.summary || `Wrote ${input.file_path}`} successfully. SHA256: ${result.fileHashAfter}`,
        uiContent,
        fileReferences: [{
          path: absolutePath,
          sha256: result.fileHashAfter,
          operation: 'write',
          contentIncluded: false
        }]
      }
    } catch {
      return { content: uiContent }
    }
  }
}
