import { Tool, ToolContext } from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'

interface ReadFilesArgs {
  filePaths: string[]
  startLine?: number
  endLine?: number
  maxCharsPerFile?: number
}

export class ReadFilesTool extends Tool {
  get name() {
    return 'read_files'
  }

  get description() {
    return 'Read one or multiple files with pagination (startLine/endLine). Returns file content, total lines, and file SHA256 hash (useful for patch verification). Truncates if too large.'
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
          description: '1-indexed start line. Default is 1.'
        },
        endLine: {
          type: 'number',
          description: '1-indexed end line. Default is up to 800 lines from startLine.'
        },
        maxCharsPerFile: {
          type: 'number',
          description: 'Maximum characters per file. Default 40000.'
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

      const startLine = parsedArgs.startLine && parsedArgs.startLine > 0 ? parsedArgs.startLine : 1
      const endLine = parsedArgs.endLine && parsedArgs.endLine >= startLine ? parsedArgs.endLine : (startLine + 800)
      const maxChars = parsedArgs.maxCharsPerFile || 40000

      const results = await Promise.all(parsedArgs.filePaths.map(async (fp) => {
        try {
          const absolutePath = path.resolve(context.workspaceRoot, fp)
          // Case-insensitive workspace root check for Windows
          if (!absolutePath.replace(/\\/g, '/').toLowerCase().startsWith(context.workspaceRoot.replace(/\\/g, '/').toLowerCase())) {
            return { path: fp, error: 'Access denied. Outside workspace.' }
          }

          const stat = await fs.stat(absolutePath)
          if (!stat.isFile()) return { path: fp, error: 'Not a file.' }

          if (stat.size > 5 * 1024 * 1024) {
             return { path: fp, error: `File too large (${(stat.size/1024/1024).toFixed(1)}MB). Max 5MB.` }
          }

          const buffer = await fs.readFile(absolutePath)
          if (buffer.subarray(0, 512).includes(0)) {
            return { path: fp, error: 'Cannot read binary file.' }
          }

          const fileHash = createHash('sha256').update(buffer).digest('hex')
          const fullContent = buffer.toString('utf-8')
          const lines = fullContent.split('\n')
          const totalLines = lines.length

          const sliceStart = startLine - 1
          const sliceEnd = Math.min(endLine, totalLines)
          
          let contentSlice = lines.slice(sliceStart, sliceEnd).join('\n')
          let truncated = false

          if (contentSlice.length > maxChars) {
            contentSlice = contentSlice.slice(0, maxChars) + '\n... (truncated due to maxChars limit)'
            truncated = true
          }

          return {
            path: fp,
            content: contentSlice,
            startLine,
            endLine: sliceEnd,
            totalLines,
            fileHash,
            truncated
          }
        } catch (err: any) {
          if (err.code === 'ENOENT') return { path: fp, error: 'File not found.' }
          return { path: fp, error: err.message }
        }
      }))

      return JSON.stringify(results, null, 2)
    } catch (err: any) {
      return `Error in read_files: ${err.message}`
    }
  }
}
