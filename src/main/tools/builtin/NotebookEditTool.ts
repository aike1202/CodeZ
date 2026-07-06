// src/main/tools/builtin/NotebookEditTool.ts
import { Tool, ToolContext } from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { getReadFingerprintStore } from '../ReadFingerprintStore'
import { parseNotebook, writeNotebook, cellIdOf, stringToSource, type NbFormat, type NbCell } from './NotebookUtils'

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
    return 'Replaces, inserts, or deletes a single cell in a Jupyter notebook (.ipynb). You MUST Read the notebook in this conversation first — this tool fails otherwise. notebook_path is absolute. cell_id is the id shown in the Read tool <cell id="..."> output; required for replace and delete. edit_mode defaults to replace. insert adds a new cell after the given cell_id (or at the beginning if omitted) — cell_type is required when inserting (defaults to code).'
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

      const absolutePath = path.isAbsolute(parsed.notebook_path)
        ? parsed.notebook_path
        : path.resolve(context.workspaceRoot, parsed.notebook_path)
      const normalizedTarget = absolutePath.replace(/\\/g, '/').toLowerCase()
      const normalizedRoot = context.workspaceRoot.replace(/\\/g, '/').toLowerCase()
      if (!normalizedTarget.startsWith(normalizedRoot)) {
        return 'Error: Access denied. Cannot modify file outside of workspace.'
      }
      if (!absolutePath.toLowerCase().endsWith('.ipynb')) {
        return 'Error: notebook_path must point to a .ipynb file.'
      }

      const sessionId = context.sessionId
      if (!sessionId || !getReadFingerprintStore().isUnchangedKnown(sessionId, absolutePath)) {
        return 'Error: You must Read this notebook in this conversation before editing it.'
      }

      const mode = parsed.edit_mode || 'replace'
      const text = await fs.readFile(absolutePath, 'utf-8')
      const nb = parseNotebook(text)

      const idx = parsed.cell_id !== undefined
        ? nb.cells.findIndex((c, i) => cellIdOf(c, i) === parsed.cell_id)
        : -1

      if (mode === 'replace') {
        if (parsed.cell_id === undefined) return 'Error: cell_id is required for replace.'
        if (idx < 0) return `Error: cell_id "${parsed.cell_id}" not found.`
        if (typeof parsed.new_source !== 'string') return 'Error: new_source is required for replace.'
        nb.cells[idx] = { ...nb.cells[idx], source: stringToSource(parsed.new_source) }
      } else if (mode === 'insert') {
        if (typeof parsed.new_source !== 'string') return 'Error: new_source is required for insert.'
        const cellType = parsed.cell_type || 'code'
        const newCell: NbCell = { cell_type: cellType, source: stringToSource(parsed.new_source), metadata: {}, outputs: cellType === 'code' ? [] : undefined }
        if (parsed.cell_id === undefined || idx < 0) {
          nb.cells.unshift(newCell)
        } else {
          nb.cells.splice(idx + 1, 0, newCell)
        }
      } else if (mode === 'delete') {
        if (parsed.cell_id === undefined) return 'Error: cell_id is required for delete.'
        if (idx < 0) return `Error: cell_id "${parsed.cell_id}" not found.`
        nb.cells.splice(idx, 1)
      } else {
        return `Error: unknown edit_mode "${mode}".`
      }

      if (context.editTransactionService && context.transactionId) {
        try { await context.editTransactionService.backupFile(context.transactionId, absolutePath) }
        catch (e: any) { return `Error: Failed to backup file before writing: ${e.message}` }
      }

      const updated = writeNotebook(nb)
      await fs.writeFile(absolutePath, updated, 'utf-8')

      const newSha = createHash('sha256').update(updated).digest('hex')
      if (sessionId) getReadFingerprintStore().record(sessionId, absolutePath, newSha)
      return `Edited cell in ${absolutePath}. New sha256: ${newSha}`
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }
}
