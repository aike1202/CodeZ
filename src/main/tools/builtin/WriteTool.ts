// src/main/tools/builtin/WriteTool.ts
import { Tool, ToolContext } from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { getReadFingerprintStore, readStatSignature } from '../ReadFingerprintStore'

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

      const absolutePath = path.isAbsolute(parsed.file_path)
        ? parsed.file_path
        : path.resolve(context.workspaceRoot, parsed.file_path)
      const normalizedTarget = absolutePath.replace(/\\/g, '/').toLowerCase()
      const normalizedRoot = context.workspaceRoot.replace(/\\/g, '/').toLowerCase()
      if (!normalizedTarget.startsWith(normalizedRoot)) {
        return 'Error: Access denied. Cannot modify file outside of workspace.'
      }

      const sessionId = context.sessionId
      const contextScopeId = context.contextScopeId ?? context.runtimeTurn?.contextScopeId ?? 'main'
      const exists = await fs.access(absolutePath).then(() => true).catch(() => false)
      if (exists) {
        const current = await fs.readFile(absolutePath)
        const currentSha = createHash('sha256').update(current).digest('hex')
        if (
          !sessionId ||
          !getReadFingerprintStore().hasDelivery(
            sessionId,
            contextScopeId,
            absolutePath,
            currentSha
          )
        ) {
          return 'Error: You must Read this file in this conversation before overwriting it. Use Edit for partial changes.'
        }
      }

      if (context.editTransactionService && context.transactionId) {
        try {
          await context.editTransactionService.backupFile(context.transactionId, absolutePath)
        } catch (e: any) {
          return `Error: Failed to backup file before writing: ${e.message}`
        }
      }

      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.writeFile(absolutePath, parsed.content, 'utf-8')

      const newSha = createHash('sha256').update(parsed.content).digest('hex')
      if (sessionId) {
        const nextStat = await fs.stat(absolutePath)
        const store = getReadFingerprintStore()
        store.recordSnapshot(sessionId, absolutePath, {
          sha256: newSha,
          buffer: Buffer.from(parsed.content, 'utf-8'),
          statSignature: readStatSignature(nextStat)
        })
        store.recordDelivery(sessionId, contextScopeId, absolutePath, newSha)
      }

      let diff = ''
      if (context.editTransactionService && context.transactionId) {
        try {
          const diffs = await context.editTransactionService.getDiff(context.transactionId)
          diff = diffs.find((d) => d.path === absolutePath)?.diff || ''
        } catch { diff = '' }
      }
      const rel = path.relative(context.workspaceRoot, absolutePath)
      return JSON.stringify({
        changedFiles: [rel],
        diff,
        summary: `Wrote ${rel}`,
        fileHashAfter: newSha
      }, null, 2)
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }
}
