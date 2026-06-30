import { Tool, ToolContext } from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'

interface ReadFilesArgs {
  filePaths: string[]
  startLine?: number
  endLine?: number
  maxCharsPerFile?: number
  maxTotalLines?: number
  maxTotalBytes?: number
  includeLineNumbers?: boolean
  contextAroundLine?: number
  contextLines?: number
}

export class ReadFilesTool extends Tool {
  get name() {
    return 'read_files'
  }

  get description() {
    return 'Read one or multiple files with pagination and budgets. Supports startLine/endLine, contextAroundLine/contextLines, maxTotalLines, maxTotalBytes, includeLineNumbers. Returns content, total lines, SHA256 hash, truncation and omitted metadata.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        filePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relative paths of files to read. (e.g. ["src/main.ts", "package.json"])'
        },
        startLine: {
          type: 'number',
          description: '1-indexed start line. Default is 1 unless contextAroundLine is provided.'
        },
        endLine: {
          type: 'number',
          description: '1-indexed end line. Default is up to 800 lines from startLine.'
        },
        maxCharsPerFile: {
          type: 'number',
          description: 'Maximum characters per file. Default 40000.'
        },
        maxTotalLines: {
          type: 'number',
          description: 'Maximum total lines returned across all files. Default 1200.'
        },
        maxTotalBytes: {
          type: 'number',
          description: 'Maximum total UTF-8 bytes returned across all files. Default 120000.'
        },
        includeLineNumbers: {
          type: 'boolean',
          description: 'Whether to prefix each returned line with its 1-based line number. Default true.'
        },
        contextAroundLine: {
          type: 'number',
          description: 'Read a context window around this 1-based line number.'
        },
        contextLines: {
          type: 'number',
          description: 'Number of lines before/after contextAroundLine. Default 5.'
        }
      },
      required: ['filePaths']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsedArgs = JSON.parse(args) as ReadFilesArgs
      if (!parsedArgs.filePaths || !Array.isArray(parsedArgs.filePaths)) {
        return 'Error: filePaths must be an array of strings.'
      }

      const maxCharsPerFile = parsedArgs.maxCharsPerFile || 40000
      const maxTotalLines = parsedArgs.maxTotalLines || 1200
      const maxTotalBytes = parsedArgs.maxTotalBytes || 120000
      const includeLineNumbers = parsedArgs.includeLineNumbers !== false
      const contextLines = parsedArgs.contextLines ?? 5

      let remainingLines = maxTotalLines
      let remainingBytes = maxTotalBytes
      let budgetExceeded = false
      let omittedFiles = 0

      const results = []

      for (const fp of parsedArgs.filePaths) {
        if (remainingLines <= 0 || remainingBytes <= 0) {
          budgetExceeded = true
          omittedFiles++
          results.push({ path: fp, error: 'Omitted because maxTotalLines or maxTotalBytes budget was exhausted.', omitted: true })
          continue
        }

        const result = await this.readOneFile(fp, context, {
          startLine: parsedArgs.startLine,
          endLine: parsedArgs.endLine,
          maxCharsPerFile,
          includeLineNumbers,
          contextAroundLine: parsedArgs.contextAroundLine,
          contextLines,
          remainingLines,
          remainingBytes
        })

        if (!('error' in result) || !result.error) {
          remainingLines -= result.returnedLines || 0
          remainingBytes -= result.returnedBytes || 0
          if (result.budgetExceeded) budgetExceeded = true
        }
        results.push(result)
      }

      return JSON.stringify({
        files: results,
        budget: {
          maxTotalLines,
          maxTotalBytes,
          remainingLines: Math.max(remainingLines, 0),
          remainingBytes: Math.max(remainingBytes, 0),
          budgetExceeded,
          omittedFiles
        }
      }, null, 2)
    } catch (err: any) {
      return `Error in read_files: ${err.message}`
    }
  }

  private async readOneFile(
    fp: string,
    context: ToolContext,
    options: {
      startLine?: number
      endLine?: number
      maxCharsPerFile: number
      includeLineNumbers: boolean
      contextAroundLine?: number
      contextLines: number
      remainingLines: number
      remainingBytes: number
    }
  ): Promise<any> {
    try {
      const absolutePath = path.resolve(context.workspaceRoot, fp)
      // Case-insensitive workspace root check for Windows
      if (!absolutePath.replace(/\\/g, '/').toLowerCase().startsWith(context.workspaceRoot.replace(/\\/g, '/').toLowerCase())) {
        return { path: fp, error: 'Access denied. Outside workspace.' }
      }

      const stat = await fs.stat(absolutePath)
      if (!stat.isFile()) return { path: fp, error: 'Not a file.' }

      if (stat.size > 5 * 1024 * 1024) {
        return { path: fp, error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max 5MB.` }
      }

      const buffer = await fs.readFile(absolutePath)
      if (buffer.subarray(0, 512).includes(0)) {
        return { path: fp, error: 'Cannot read binary file.' }
      }

      const fileHash = createHash('sha256').update(buffer).digest('hex')
      const fullContent = buffer.toString('utf-8')
      const lines = fullContent.split('\n')
      const totalLines = lines.length

      let startLine: number
      let endLine: number
      if (options.contextAroundLine && options.contextAroundLine > 0) {
        startLine = Math.max(1, options.contextAroundLine - options.contextLines)
        endLine = Math.min(totalLines, options.contextAroundLine + options.contextLines)
      } else {
        startLine = options.startLine && options.startLine > 0 ? options.startLine : 1
        endLine = options.endLine && options.endLine >= startLine ? options.endLine : Math.min(startLine + 800, totalLines)
      }

      const sliceStart = startLine - 1
      const requestedSliceEnd = Math.min(endLine, totalLines)
      let selectedLines = lines.slice(sliceStart, requestedSliceEnd)

      let omittedLines = Math.max(0, totalLines - selectedLines.length)
      let truncated = requestedSliceEnd < totalLines || startLine > 1
      let budgetExceeded = false

      if (selectedLines.length > options.remainingLines) {
        omittedLines += selectedLines.length - options.remainingLines
        selectedLines = selectedLines.slice(0, options.remainingLines)
        truncated = true
        budgetExceeded = true
      }

      if (options.includeLineNumbers) {
        selectedLines = selectedLines.map((line, index) => `${startLine + index}\t${line}`)
      }

      let contentSlice = selectedLines.join('\n')
      let omittedBytes = 0

      if (contentSlice.length > options.maxCharsPerFile) {
        omittedBytes += contentSlice.length - options.maxCharsPerFile
        contentSlice = contentSlice.slice(0, options.maxCharsPerFile) + 
          '\n\n[System Note: Content truncated due to maxCharsPerFile limit. You MUST use startLine and endLine parameters in your next call to paginate and read the rest of this file. Do NOT retry reading the whole file without pagination.]'
        truncated = true
      }

      const byteLength = Buffer.byteLength(contentSlice, 'utf-8')
      if (byteLength > options.remainingBytes) {
        const originalBytes = byteLength
        contentSlice = Buffer.from(contentSlice, 'utf-8').subarray(0, options.remainingBytes).toString('utf-8') + 
          '\n\n[System Note: Content truncated due to maxTotalBytes budget limit. You MUST use startLine and endLine parameters in your next call to paginate.]'
        omittedBytes += originalBytes - options.remainingBytes
        truncated = true
        budgetExceeded = true
      }

      const returnedBytes = Buffer.byteLength(contentSlice, 'utf-8')
      const returnedLines = selectedLines.length

      return {
        path: fp,
        content: contentSlice,
        startLine,
        endLine: startLine + Math.max(returnedLines - 1, 0),
        requestedEndLine: requestedSliceEnd,
        totalLines,
        fileHash,
        truncated,
        omittedLines,
        omittedBytes,
        returnedLines,
        returnedBytes,
        budgetExceeded,
        includeLineNumbers: options.includeLineNumbers
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') return { path: fp, error: 'File not found.' }
      return { path: fp, error: err.message }
    }
  }
}
