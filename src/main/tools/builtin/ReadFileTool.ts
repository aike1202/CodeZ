import { Tool, ToolContext } from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'

export class ReadFileTool extends Tool {
  get name() {
    return 'read_file'
  }

  get description() {
    return 'Reads the content of a specified file inside the workspace. Use this to inspect code or text files.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'The relative path of the file to read (e.g., "src/main/index.ts", "package.json").'
        }
      },
      required: ['filePath']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      if (!args) return 'Error: Missing arguments.'
      const parsedArgs = JSON.parse(args)
      const filePath = parsedArgs.filePath
      if (!filePath) return 'Error: filePath is required.'

      const targetPath = path.resolve(context.workspaceRoot, filePath)

      // 防御限制
      if (!targetPath.startsWith(context.workspaceRoot)) {
        return `Error: Access denied. Cannot read file outside of workspace.`
      }

      const stat = await fs.stat(targetPath)
      if (!stat.isFile()) {
        return `Error: Target is not a file.`
      }

      // 简单截断超大文件(假设最大读取100KB)
      if (stat.size > 100 * 1024) {
        return `Error: File is too large to read entirely (size: ${stat.size} bytes). Max limit is 100KB.`
      }

      const content = await fs.readFile(targetPath, 'utf-8')
      return content
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return `Error: File not found.`
      }
      return `Error reading file: ${err.message}`
    }
  }
}
