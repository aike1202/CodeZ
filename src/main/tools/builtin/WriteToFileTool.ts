import { Tool, ToolContext } from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'

export class WriteToFileTool extends Tool {
  get name() {
    return 'write_to_file'
  }

  get description() {
    return 'Creates a new file or completely overwrites an existing file with new content. Use this to create new code files or when replacing the entire file content is easier than partial edits.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        targetFile: {
          type: 'string',
          description: 'The relative path of the file to write (e.g., "src/utils/math.ts").'
        },
        codeContent: {
          type: 'string',
          description: 'The complete code or text content to write to the file.'
        },
        overwrite: {
          type: 'boolean',
          description: 'Set this to true to explicitly allow overwriting an existing file. If false and the file exists, the tool will throw an error.'
        }
      },
      required: ['targetFile', 'codeContent']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      if (!args) return 'Error: Missing arguments.'
      const parsedArgs = JSON.parse(args)
      const targetFile = parsedArgs.targetFile
      const codeContent = parsedArgs.codeContent
      const overwrite = parsedArgs.overwrite ?? false

      if (!targetFile) return 'Error: targetFile is required.'
      if (typeof codeContent !== 'string') return 'Error: codeContent is required and must be a string.'

      const absolutePath = path.resolve(context.workspaceRoot, targetFile)

      // 防御限制：必须在工作区内
      if (!absolutePath.startsWith(context.workspaceRoot)) {
        return `Error: Access denied. Cannot write file outside of workspace.`
      }

      // 检查文件是否存在
      let fileExists = false
      try {
        const stat = await fs.stat(absolutePath)
        if (stat.isDirectory()) {
          return `Error: Target is a directory, not a file.`
        }
        fileExists = true
      } catch (err: any) {
        if (err.code !== 'ENOENT') {
          return `Error checking file: ${err.message}`
        }
      }

      if (fileExists && !overwrite) {
        return `Error: File already exists at ${targetFile}. Set 'overwrite: true' if you intend to replace it.`
      }

      // 自动接入事务备份机制
      if (context.editTransactionService && context.transactionId) {
        try {
          await context.editTransactionService.backupFile(context.transactionId, absolutePath)
        } catch (backupErr: any) {
          console.error(`[WriteToFileTool] Backup failed for ${absolutePath}:`, backupErr)
          // 备份失败一般不阻断修改，除非需要极高安全级别
        }
      }

      // 自动创建所需目录
      const dir = path.dirname(absolutePath)
      await fs.mkdir(dir, { recursive: true })

      // 写入文件
      await fs.writeFile(absolutePath, codeContent, 'utf-8')

      return `Successfully wrote to file: ${targetFile}`
    } catch (err: any) {
      return `Error writing file: ${err.message}`
    }
  }
}
