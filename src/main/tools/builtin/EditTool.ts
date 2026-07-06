// src/main/tools/builtin/EditTool.ts
import { Tool, ToolContext } from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { getReadFingerprintStore } from '../ReadFingerprintStore'

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

      const absolutePath = path.isAbsolute(parsed.file_path)
        ? parsed.file_path
        : path.resolve(context.workspaceRoot, parsed.file_path)
      const normalizedTarget = absolutePath.replace(/\\/g, '/').toLowerCase()
      const normalizedRoot = context.workspaceRoot.replace(/\\/g, '/').toLowerCase()
      if (!normalizedTarget.startsWith(normalizedRoot)) {
        return 'Error: Access denied. Cannot modify file outside of workspace.'
      }

      const sessionId = context.sessionId
      if (!sessionId || !getReadFingerprintStore().isUnchangedKnown(sessionId, absolutePath)) {
        return 'Error: You must Read this file in this conversation before editing it.'
      }

      let fileContent: string
      try {
        fileContent = await fs.readFile(absolutePath, 'utf-8')
      } catch (err: any) {
        if (err.code === 'ENOENT') return 'Error: File not found. Use Write to create it.'
        return `Error: ${err.message}`
      }

      const target = stripLinePrefix(parsed.old_string.replace(/\r\n/g, '\n'))
      const replacement = parsed.new_string.replace(/\r\n/g, '\n')
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

      if (context.editTransactionService && context.transactionId) {
        try {
          await context.editTransactionService.backupFile(context.transactionId, absolutePath)
        } catch (e: any) {
          return `Error: Failed to backup file before writing: ${e.message}`
        }
      }

      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.writeFile(absolutePath, updated, 'utf-8')

      const newSha = createHash('sha256').update(updated).digest('hex')
      if (sessionId) getReadFingerprintStore().record(sessionId, absolutePath, newSha)

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
        summary: `Edited ${rel}`,
        fileHashAfter: newSha
      }, null, 2)
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }
}
