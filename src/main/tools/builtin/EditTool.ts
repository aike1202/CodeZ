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

interface EditOperation {
  old_string?: string
  new_string?: string
  replace_all?: boolean
}

interface EditArgs {
  file_path?: string
  edits?: EditOperation[]
}

export class EditTool extends Tool {
  get name() {
    return 'Edit'
  }

  get summary() {
    return 'Make atomic exact string replacements in a file.'
  }

  get description() {
    return 'Performs atomic exact string replacements in one existing file. You MUST Read the current file in this agent context before editing, or the call fails. Put every known targeted change for the same file in one edits array; edits are applied in order to an in-memory copy and the file is written only if every edit succeeds. Copy content after the Read line-number prefix and preserve its exact indentation; NEVER include any part of the line-number prefix in old_string or new_string. Each old_string must be non-empty, differ from new_string, match exactly, and be unique unless replace_all is true. Use the smallest old_string that is clearly unique, and use replace_all for replacing or renaming the same text throughout the file. Use Write for new files or intentional full rewrites.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: { type: 'string', description: 'Absolute (or workspace-relative) path of the file to edit.' },
        edits: {
          type: 'array',
          minItems: 1,
          description: 'Ordered exact replacements for this file. All edits succeed or the file remains unchanged.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              old_string: {
                type: 'string',
                minLength: 1,
                description: 'Exact text to find, without any Read line-number prefix. Must be unique unless replace_all is true.'
              },
              new_string: {
                type: 'string',
                description: 'Exact replacement text. Must differ from old_string.'
              },
              replace_all: {
                type: 'boolean',
                description: 'If true, replace every occurrence of old_string. Default false.'
              }
            },
            required: ['old_string', 'new_string']
          }
        }
      },
      required: ['file_path', 'edits']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as EditArgs
      if (!parsed.file_path) return 'Error: file_path is required.'
      if (!Array.isArray(parsed.edits) || parsed.edits.length === 0) {
        return 'Error: edits must be a non-empty array.'
      }
      const filePath = parsed.file_path
      const edits = parsed.edits

      for (let index = 0; index < edits.length; index++) {
        const edit = edits[index]
        if (!edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') {
          return `Error: Edit ${index + 1}: old_string and new_string are required.`
        }
        if (edit.old_string.length === 0) {
          return `Error: Edit ${index + 1}: old_string must not be empty. Use Write for new files or full rewrites.`
        }
        if (edit.old_string === edit.new_string) {
          return `Error: Edit ${index + 1}: old_string and new_string must be different.`
        }
        if (edit.replace_all !== undefined && typeof edit.replace_all !== 'boolean') {
          return `Error: Edit ${index + 1}: replace_all must be a boolean.`
        }
      }

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

        const working = fileContent.replace(/\r\n/g, '\n')
        let updated = working
        const appliedNewStrings: string[] = []

        for (let index = 0; index < edits.length; index++) {
          const edit = edits[index]
          const target = edit.old_string!.replace(/\r\n/g, '\n')
          const replacement = edit.new_string!.replace(/\r\n/g, '\n')
          const targetWithoutTrailingNewlines = target.replace(/\n+$/, '')

          if (
            targetWithoutTrailingNewlines &&
            appliedNewStrings.some((previous) => previous.includes(targetWithoutTrailingNewlines))
          ) {
            return `Error: Edit ${index + 1}: old_string is a substring of new_string from a previous edit.`
          }

          const occurrences = updated.split(target).length - 1
          if (occurrences === 0) {
            return `Error: Edit ${index + 1}: old_string not found. Ensure an exact match without Read line-number prefixes; re-Read the relevant range before retrying.`
          }
          if (occurrences > 1 && !edit.replace_all) {
            return `Error: Edit ${index + 1}: old_string is not unique (${occurrences} matches). Use replace_all: true or expand old_string to be unique.`
          }

          updated = edit.replace_all
            ? updated.split(target).join(replacement)
            : updated.replace(target, () => replacement)
          appliedNewStrings.push(replacement)
        }

        if (updated === working) {
          return 'Error: The edit batch produces no net change.'
        }

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
          summary: `Edited ${rel} with ${edits.length} replacement${edits.length === 1 ? '' : 's'}`,
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
