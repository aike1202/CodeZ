import { Tool, ToolContext } from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'

export class ListFilesTool extends Tool {
  get name() {
    return 'list_files'
  }

  get summary() {
    return 'List files in a directory.'
  }

  get description() {
    return 'Lists files and directories within one or multiple directory paths in a single call. Use this tool to inspect multiple directory structures without calling list_files repeatedly.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        dirPaths: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'An array of relative directory paths to list (e.g., ["src/components", "src/pages"]).'
        },
        dirPath: {
          type: 'string',
          description: 'The relative path of a single directory to list. (Legacy parameter, dirPaths is preferred).'
        }
      }
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsedArgs = args ? JSON.parse(args) : {}
      
      // 提取路径列表：兼容 dirPaths 数组和 dirPath 字符串
      let targetPaths: string[] = []
      if (Array.isArray(parsedArgs.dirPaths)) {
        targetPaths = parsedArgs.dirPaths
      } else if (typeof parsedArgs.dirPath === 'string') {
        targetPaths = [parsedArgs.dirPath]
      } else {
        targetPaths = ['.']
      }

      const output: string[] = []

      for (const dir of targetPaths) {
        const cleanDir = dir || '.'
        const targetDir = path.resolve(context.workspaceRoot, cleanDir)
        
        // 防止跃出 Workspace 限制
        if (!targetDir.startsWith(context.workspaceRoot)) {
          output.push(`=== Directory: ${cleanDir} ===\nError: Access denied. Cannot list files outside of workspace.`)
          continue
        }

        try {
          const files = await fs.readdir(targetDir, { withFileTypes: true })
          const dirLines = files.map(dirent => {
            return `${dirent.isDirectory() ? '[DIR]' : '[FILE]'} ${dirent.name}`
          })
          const content = dirLines.length > 0 ? dirLines.join('\n') : 'Empty directory.'
          
          if (targetPaths.length > 1) {
            output.push(`=== Directory: ${cleanDir} ===\n${content}`)
          } else {
            output.push(content)
          }
        } catch (err: any) {
          if (targetPaths.length > 1) {
            output.push(`=== Directory: ${cleanDir} ===\nError listing files: ${err.message}`)
          } else {
            output.push(`Error listing files: ${err.message}`)
          }
        }
      }

      return output.join('\n\n')
    } catch (err: any) {
      return `Error parsing tool arguments: ${err.message}`
    }
  }
}
