// src/main/tools/builtin/EditTool.ts
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

interface EditArgs {
  file_path?: string
  old_string?: string
  new_string?: string
  replace_all?: boolean
}

/** 剥除 Read 输出的 `行号\t` 前缀（逐行）。 */
function stripLinePrefix(s: string): string {
  return s.replace(/^(\d+)\t/gm, '')
}

export class EditTool extends Tool {
  get name() {
    return 'Edit'
  }

  get summary() {
    return 'Make exact string replacements in a file.'
  }

  get description() {
    return 'Performs exact string replacement in a file. You MUST Read the file in this conversation before editing, or the call fails. old_string must match exactly (including indentation) and be unique — the edit fails otherwise; the Read line prefix (line number + tab) is stripped automatically before matching. Use replace_all: true to replace every occurrence. For creating files or full rewrites use Write instead.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute (or workspace-relative) path of the file to edit.' },
        old_string: { type: 'string', description: 'Exact text to find. Must be unique unless replace_all is true.' },
        new_string: { type: 'string', description: 'Text to replace it with.' },
        replace_all: { type: 'boolean', description: 'If true, replace every occurrence. Default false.' }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as EditArgs
      if (!parsed.file_path) return 'Error: file_path is required.'
      if (typeof parsed.old_string !== 'string' || typeof parsed.new_string !== 'string') {
        return 'Error: old_string and new_string are required.'
      }
      const filePath = parsed.file_path
      const oldString = parsed.old_string
      const newString = parsed.new_string

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
        let fileContent: string
        try {
          fileContent = await fs.readFile(absolutePath, 'utf-8')
        } catch (err: any) {
          if (err.code === 'ENOENT') return 'Error: File not found. Use Write to create it.'
          return `Error: ${err.message}`
        }

        const sessionId = context.sessionId
        const contextScopeId = context.contextScopeId ?? context.runtimeTurn?.contextScopeId ?? 'main'
        const currentSha = createHash('sha256').update(fileContent).digest('hex')
        if (
          !sessionId ||
          !getReadFingerprintStore().hasDelivery(
            sessionId,
            contextScopeId,
            absolutePath,
            currentSha
          )
        ) {
          return 'Error: You must Read the current version of this file in this agent context before editing it.'
        }

        const target = stripLinePrefix(oldString.replace(/\r\n/g, '\n'))
        const replacement = newString.replace(/\r\n/g, '\n')
        const working = fileContent.replace(/\r\n/g, '\n')
        const occurrences = working.split(target).length - 1

        if (occurrences === 0) {
          return 'Error: old_string not found. Ensure exact match including whitespace; re-Read the relevant range before retrying.'
        }
        if (occurrences > 1 && !parsed.replace_all) {
          return `Error: old_string is not unique (${occurrences} matches). Use replace_all: true or expand old_string to be unique.`
        }

        const updated = parsed.replace_all
          ? working.split(target).join(replacement)
          : working.replace(target, replacement)

        let stagedBackup = false
        if (context.editTransactionService && context.transactionId) {
          try {
            stagedBackup = await context.editTransactionService.backupFile(
              context.transactionId,
              absolutePath,
              fileContent
            )
          } catch (e: any) {
            return `Error: Failed to backup file before writing: ${e.message}`
          }
        }

        let latestContent: string
        try {
          latestContent = await fs.readFile(absolutePath, 'utf-8')
        } catch {
          await discardStagedBackup(context, absolutePath, stagedBackup)
          return 'Error: File changed after validation. Re-Read the current version before editing.'
        }
        const latestSha = createHash('sha256').update(latestContent).digest('hex')
        if (latestSha !== currentSha) {
          await discardStagedBackup(context, absolutePath, stagedBackup)
          return 'Error: File changed after validation. Re-Read the current version before editing.'
        }

        try {
          throwIfToolAborted(context.abortSignal)
          assertStableWorkspacePathSync(requestedPath, context.workspaceRoot, absolutePath)
        } catch (error) {
          await discardStagedBackup(context, absolutePath, stagedBackup)
          throw error
        }
        await fs.writeFile(absolutePath, updated, 'utf-8')

        const newSha = createHash('sha256').update(updated).digest('hex')
        await recordTransactionMutation(context, absolutePath, newSha)
        if (sessionId) {
          const nextStat = await fs.stat(absolutePath)
          const store = getReadFingerprintStore()
          store.recordSnapshot(sessionId, absolutePath, {
            sha256: newSha,
            buffer: Buffer.from(updated, 'utf-8'),
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
          summary: `Edited ${rel}`,
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
      const input = JSON.parse(args) as EditArgs
      const result = JSON.parse(uiContent) as { summary?: string; fileHashAfter?: string }
      if (!input.file_path || !result.fileHashAfter) return { content: uiContent }
      const absolutePath = analyzePathImpactSync(input.file_path, context.workspaceRoot).resolvedPath
      return {
        content: `${result.summary || `Edited ${input.file_path}`} successfully. SHA256: ${result.fileHashAfter}`,
        uiContent,
        fileReferences: [{
          path: absolutePath,
          sha256: result.fileHashAfter,
          operation: 'edit',
          contentIncluded: false
        }]
      }
    } catch {
      return { content: uiContent }
    }
  }
}
