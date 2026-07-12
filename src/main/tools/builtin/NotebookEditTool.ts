// src/main/tools/builtin/NotebookEditTool.ts
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
import { getFileMutationCoordinator } from '../FileMutationCoordinator'
import { getReadFingerprintStore, readStatSignature } from '../ReadFingerprintStore'
import { parseNotebook, writeNotebook, cellIdOf, stringToSource, type NbCell } from './NotebookUtils'
import {
  analyzePathImpactSync,
  assertStableWorkspacePathSync
} from '../../services/permission/PathImpactAnalyzer'

interface NotebookEditArgs {
  notebook_path?: string
  cell_id?: string
  cell_type?: string
  new_source?: string
  edit_mode?: 'replace' | 'insert' | 'delete'
}

export class NotebookEditTool extends Tool {
  get name() {
    return 'NotebookEdit'
  }

  get summary() {
    return 'Edit cells in a Jupyter notebook.'
  }

  get description() {
    return 'Replaces, inserts, or deletes a single cell in a Jupyter notebook (.ipynb). You MUST Read the notebook in this conversation first - this tool fails otherwise. notebook_path is absolute. cell_id is the id shown in the Read tool <cell id="..."> output; required for replace and delete. edit_mode defaults to replace. insert adds a new cell after the given cell_id (or at the beginning if omitted) - cell_type is required when inserting (defaults to code).'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        notebook_path: { type: 'string', description: 'Absolute (or workspace-relative) path of the .ipynb file.' },
        cell_id: { type: 'string', description: 'The id from <cell id="...">. Required for replace/delete; optional for insert.' },
        cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'], description: 'Cell type for insert. Defaults to code.' },
        new_source: { type: 'string', description: 'The new cell source. Required for replace and insert.' },
        edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'Default replace.' }
      },
      required: ['notebook_path']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as NotebookEditArgs
      if (!parsed.notebook_path) return 'Error: notebook_path is required.'

      const requestedPath = path.isAbsolute(parsed.notebook_path)
        ? parsed.notebook_path
        : path.resolve(context.workspaceRoot, parsed.notebook_path)
      const pathImpact = analyzePathImpactSync(requestedPath, context.workspaceRoot)
      if (!pathImpact.insideWorkspace) {
        return 'Error: Access denied. Cannot modify file outside of workspace.'
      }
      const absolutePath = pathImpact.resolvedPath
      if (!absolutePath.toLowerCase().endsWith('.ipynb')) {
        return 'Error: notebook_path must point to a .ipynb file.'
      }

      return await runWithTransactionLock(context, () =>
        getFileMutationCoordinator().run(absolutePath, async () => {
        assertStableWorkspacePathSync(requestedPath, context.workspaceRoot, absolutePath)
        const mode = parsed.edit_mode || 'replace'
        const text = await fs.readFile(absolutePath, 'utf-8')
        const sessionId = context.sessionId
        const contextScopeId = context.contextScopeId ?? context.runtimeTurn?.contextScopeId ?? 'main'
        const currentSha = createHash('sha256').update(text).digest('hex')
        if (
          !sessionId ||
          !getReadFingerprintStore().hasDelivery(
            sessionId,
            contextScopeId,
            absolutePath,
            currentSha
          )
        ) {
          return 'Error: You must Read the current version of this notebook in this agent context before editing it.'
        }

        const nb = parseNotebook(text)
        const idx = parsed.cell_id !== undefined
          ? nb.cells.findIndex((cell, index) => cellIdOf(cell, index) === parsed.cell_id)
          : -1

        if (mode === 'replace') {
          if (parsed.cell_id === undefined) return 'Error: cell_id is required for replace.'
          if (idx < 0) return `Error: cell_id "${parsed.cell_id}" not found.`
          if (typeof parsed.new_source !== 'string') return 'Error: new_source is required for replace.'
          nb.cells[idx] = { ...nb.cells[idx], source: stringToSource(parsed.new_source) }
        } else if (mode === 'insert') {
          if (typeof parsed.new_source !== 'string') return 'Error: new_source is required for insert.'
          const cellType = parsed.cell_type || 'code'
          const newCell: NbCell = {
            cell_type: cellType,
            source: stringToSource(parsed.new_source),
            metadata: {},
            outputs: cellType === 'code' ? [] : undefined
          }
          if (parsed.cell_id === undefined || idx < 0) nb.cells.unshift(newCell)
          else nb.cells.splice(idx + 1, 0, newCell)
        } else if (mode === 'delete') {
          if (parsed.cell_id === undefined) return 'Error: cell_id is required for delete.'
          if (idx < 0) return `Error: cell_id "${parsed.cell_id}" not found.`
          nb.cells.splice(idx, 1)
        } else {
          return `Error: unknown edit_mode "${mode}".`
        }

        let stagedBackup = false
        if (context.editTransactionService && context.transactionId) {
          try {
            stagedBackup = await context.editTransactionService.backupFile(
              context.transactionId,
              absolutePath,
              text
            )
          } catch (error: any) {
            return `Error: Failed to backup file before writing: ${error.message}`
          }
        }

        let latestText: string
        try {
          latestText = await fs.readFile(absolutePath, 'utf-8')
        } catch {
          await discardStagedBackup(context, absolutePath, stagedBackup)
          return 'Error: Notebook changed after validation. Re-Read it before editing.'
        }
        if (createHash('sha256').update(latestText).digest('hex') !== currentSha) {
          await discardStagedBackup(context, absolutePath, stagedBackup)
          return 'Error: Notebook changed after validation. Re-Read it before editing.'
        }

        const updated = writeNotebook(nb)
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
        const nextStat = await fs.stat(absolutePath)
        const store = getReadFingerprintStore()
        store.recordSnapshot(sessionId, absolutePath, {
          sha256: newSha,
          buffer: Buffer.from(updated, 'utf-8'),
          statSignature: readStatSignature(nextStat)
        })
        store.recordDelivery(sessionId, contextScopeId, absolutePath, newSha)
        return `Edited cell in ${absolutePath}. New sha256: ${newSha}`
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
    const content = await this.execute(args, context)
    if (content.startsWith('Error:')) return { content }
    const sha256 = content.match(/New sha256: ([0-9a-f]{64})/)?.[1]
    try {
      const input = JSON.parse(args) as NotebookEditArgs
      if (!input.notebook_path || !sha256) return { content }
      const absolutePath = analyzePathImpactSync(input.notebook_path, context.workspaceRoot).resolvedPath
      return {
        content,
        fileReferences: [{
          path: absolutePath,
          sha256,
          operation: 'edit',
          contentIncluded: false
        }]
      }
    } catch {
      return { content }
    }
  }
}
