// src/main/tools/builtin/ReadTool.ts
import { Tool, ToolContext } from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { getReadFingerprintStore } from '../ReadFingerprintStore'

interface ReadArgs {
  file_path?: string
  offset?: number
  limit?: number
  pages?: string
}

const MAX_TOTAL_LINES = 1200
const MAX_TOTAL_BYTES = 120000
const MAX_CHARS_PER_FILE = 40000
const MAX_FILE_BYTES = 5 * 1024 * 1024

export class ReadTool extends Tool {
  get name() {
    return 'Read'
  }

  get description() {
    return 'Reads a file from the local filesystem. file_path is absolute (or relative to workspace). Returns content in cat -n format (line numbers starting at 1). When you already know which part you need, use offset/limit to read only that part. Do NOT re-read a file you just edited or one whose content has not changed — a repeated Read of an unchanged file returns "Wasted call" and no content. Binary files return "Cannot read binary file."; images/PDFs are not supported this period. Reading a directory, missing file, or empty file returns an error.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute (or workspace-relative) path of the file to read.' },
        offset: { type: 'number', description: '1-indexed line to start reading from. Default 1.' },
        limit: { type: 'number', description: 'Maximum number of lines to return. Default up to budget.' },
        pages: { type: 'string', description: 'Reserved for PDF pages; not implemented this period (ignored).' }
      },
      required: ['file_path']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as ReadArgs
      if (!parsed.file_path) return 'Error: file_path is required.'

      const absolutePath = path.isAbsolute(parsed.file_path)
        ? parsed.file_path
        : path.resolve(context.workspaceRoot, parsed.file_path)
      const normalizedTarget = absolutePath.replace(/\\/g, '/').toLowerCase()
      const normalizedRoot = context.workspaceRoot.replace(/\\/g, '/').toLowerCase()
      if (!normalizedTarget.startsWith(normalizedRoot)) {
        return 'Error: Access denied. Cannot read file outside of workspace.'
      }

      const stat = await fs.stat(absolutePath).catch((e: any) => { throw e })
      if (!stat.isFile()) return 'Error: Not a file.'
      if (stat.size > MAX_FILE_BYTES) {
        return `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max 5MB.`
      }

      const buffer = await fs.readFile(absolutePath)
      if (buffer.subarray(0, 512).includes(0)) {
        return 'Cannot read binary file.'
      }

      const sha = createHash('sha256').update(buffer).digest('hex')
      const sessionId = context.sessionId
      if (sessionId) {
        const store = getReadFingerprintStore()
        if (store.isUnchanged(sessionId, absolutePath, sha)) {
          return 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.'
        }
      }

      const fullContent = buffer.toString('utf-8')
      const lines = fullContent.split('\n')
      const totalLines = lines.length

      const offset = parsed.offset && parsed.offset > 0 ? parsed.offset : 1
      const sliceStart = offset - 1
      let limit = parsed.limit && parsed.limit > 0 ? parsed.limit : MAX_TOTAL_LINES
      let selected = lines.slice(sliceStart, sliceStart + limit)

      let truncated = false
      if (selected.length > MAX_TOTAL_LINES) {
        selected = selected.slice(0, MAX_TOTAL_LINES)
        truncated = true
      }

      const numbered = selected.map((line, i) => `${offset + i}\t${line}`)
      let text = numbered.join('\n')

      if (text.length > MAX_CHARS_PER_FILE) {
        text = text.slice(0, MAX_CHARS_PER_FILE) +
          '\n\n[System Note: Content truncated due to maxCharsPerFile limit. Use offset/limit to paginate.]'
        truncated = true
      }
      const byteLen = Buffer.byteLength(text, 'utf-8')
      if (byteLen > MAX_TOTAL_BYTES) {
        text = Buffer.from(text, 'utf-8').subarray(0, MAX_TOTAL_BYTES).toString('utf-8') +
          '\n\n[System Note: Content truncated due to maxTotalBytes budget. Use offset/limit to paginate.]'
        truncated = true
      }

      if (sessionId) getReadFingerprintStore().record(sessionId, absolutePath, sha)

      const note = truncated ? `\n[truncated: ${totalLines} total lines]` : ''
      return `${text}${note}\n\nSHA256: ${sha}`
    } catch (err: any) {
      if (err.code === 'ENOENT') return 'Error: File not found.'
      return `Error: ${err.message}`
    }
  }
}
