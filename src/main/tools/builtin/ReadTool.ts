// src/main/tools/builtin/ReadTool.ts
import { Tool, ToolContext } from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import {
  getReadFingerprintStore,
  readStatSignature,
  type ReadSnapshotSource
} from '../ReadFingerprintStore'
import { parseNotebook, renderNotebook } from './NotebookUtils'

interface ReadFileArgs {
  file_path: string
  offset?: number
  limit?: number
  pages?: string
}

interface ReadArgs {
  files?: ReadFileArgs[]
}

const MAX_TOTAL_LINES = 1200
const MAX_CHARS_PER_FILE = 40000
const MAX_CHARS_PER_BATCH = 24000
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_FILES_PER_READ = 8

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export class ReadTool extends Tool {
  get name() {
    return 'Read'
  }

  get summary() {
    return 'Read up to eight local files in parallel.'
  }

  get description() {
    return 'Reads 1 to 8 files from a session-shared versioned snapshot cache, loading each unchanged file from the filesystem at most once per workspace path. Pass every request through the required files array, including single-file reads. Before calling Read, collect every file and range already known. If two or more independent targets are known, put them in as few files arrays as the schema permits; when they exceed one array\'s capacity, issue the additional independent Read calls in the same response. For the same file, merge adjacent or overlapping ranges instead of issuing sequential calls. Use a one-item array only when there is truly one target or when the next target depends on the current result. Each file_path may be absolute or workspace-relative. For an initial read without an evidence-based relevant range, omit offset and limit. A known relevant range is permitted even on the first read. Do not probe arbitrary first 50 or 100 lines. Use offset/limit only for such a known range, when the default result was marked truncated or reached its documented content-budget boundary, or when context trimming removed earlier content. A default text read returns up to 1,200 lines and may stop earlier at the shared batch content budget. Cached and range reads return the requested content instead of a content-free deduplication response. After a file changes, re-read it without an arbitrary range unless a permitted range condition applies. Results are returned in input order as <file path="..."> blocks with cat -n line numbers, snapshot source, and SHA256. One file error does not prevent other files from returning. Binary files are not readable. Images and PDFs are not supported (pages is reserved and ignored). Jupyter notebooks render as <cell id="..."> blocks.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Files to read concurrently. Use a one-item array for a single file.',
          minItems: 1,
          maxItems: MAX_FILES_PER_READ,
          items: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
              offset: { type: 'number', description: '1-indexed line to start reading from. Omit for an initial read without an evidence-based relevant range; use only for such a range, a marked truncation or documented budget boundary, or context recovery.' },
              limit: { type: 'number', description: 'Maximum number of lines to return. Omit for an initial read without an evidence-based relevant range; use only for such a range, a marked truncation or documented budget boundary, or context recovery.' },
              pages: { type: 'string', description: 'Reserved for PDF pages; currently ignored.' }
            },
            required: ['file_path'],
            additionalProperties: false
          }
        }
      },
      required: ['files'],
      additionalProperties: false
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as ReadArgs
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.files)) {
        return 'Error: files is required.'
      }
      if (Object.keys(parsed).some((key) => key !== 'files')) {
        return 'Error: Read only accepts the files parameter.'
      }
      if (parsed.files.length < 1 || parsed.files.length > MAX_FILES_PER_READ) {
        return `Error: files must contain between 1 and ${MAX_FILES_PER_READ} items.`
      }
      const invalidIndex = parsed.files.findIndex((file) => !file || typeof file.file_path !== 'string' || !file.file_path)
      if (invalidIndex >= 0) return `Error: files[${invalidIndex}].file_path is required.`

      const perFileCharBudget = Math.max(
        2000,
        Math.min(MAX_CHARS_PER_FILE, Math.floor(MAX_CHARS_PER_BATCH / parsed.files.length))
      )
      const results = await Promise.all(
        parsed.files.map((file) => this.readOneFile(file, context, perFileCharBudget))
      )
      return results
        .map((result, index) =>
          `<file path="${escapeAttribute(parsed.files![index].file_path)}">\n${result}\n</file>`
        )
        .join('\n\n')
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }

  private async readOneFile(
    parsed: ReadFileArgs,
    context: ToolContext,
    charBudget: number
  ): Promise<string> {
    try {

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

      const sessionId = context.sessionId
      let source: ReadSnapshotSource = 'filesystem'
      let buffer: Buffer
      let sha: string
      if (sessionId) {
        const loaded = await getReadFingerprintStore().getOrLoadSnapshot(
          sessionId,
          absolutePath,
          readStatSignature(stat),
          async () => {
            const nextBuffer = await fs.readFile(absolutePath)
            const nextStat = await fs.stat(absolutePath)
            return {
              buffer: nextBuffer,
              sha256: createHash('sha256').update(nextBuffer).digest('hex'),
              statSignature: readStatSignature(nextStat)
            }
          }
        )
        buffer = loaded.snapshot.buffer
        sha = loaded.snapshot.sha256
        source = loaded.source
      } else {
        buffer = await fs.readFile(absolutePath)
        sha = createHash('sha256').update(buffer).digest('hex')
      }
      if (buffer.subarray(0, 512).includes(0)) {
        return 'Cannot read binary file.'
      }

      const contextScopeId = context.contextScopeId ?? context.runtimeTurn?.contextScopeId ?? 'main'
      if (sessionId) {
        getReadFingerprintStore().recordDelivery(sessionId, contextScopeId, absolutePath, sha)
      }

      // .ipynb 特化：渲染为 <cell id="..."> 文本块（仍是纯文本，不算图片/PDF 入能力）
      if (absolutePath.toLowerCase().endsWith('.ipynb')) {
        try {
          const nb = parseNotebook(buffer.toString('utf-8'))
          return `${renderNotebook(nb)}\n\nSource: ${source}\nSHA256: ${sha}`
        } catch (e: any) {
          // 解析失败则按普通文本回退（下方逻辑继续）
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

      if (text.length > charBudget) {
        text = text.slice(0, charBudget) +
          '\n\n[System Note: Content truncated due to the shared Read batch budget. Use a targeted offset/limit range to continue.]'
        truncated = true
      }

      const note = truncated ? `\n[truncated: ${totalLines} total lines]` : ''
      return `${text}${note}\n\nSource: ${source}\nSHA256: ${sha}`
    } catch (err: any) {
      if (err.code === 'ENOENT') return 'Error: File not found.'
      return `Error: ${err.message}`
    }
  }
}
