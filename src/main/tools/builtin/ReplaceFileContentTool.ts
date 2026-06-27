import { Tool, ToolContext } from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'

export class ReplaceFileContentTool extends Tool {
  get name() {
    return 'replace_file_content'
  }

  get description() {
    return 'Replaces a specific block of text in a file with new content. Use this for targeted, partial edits. The targetContent must match the existing file content exactly (including whitespace and indentation).'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        targetFile: {
          type: 'string',
          description: 'The relative path of the file to modify (e.g., "src/main/index.ts").'
        },
        targetContent: {
          type: 'string',
          description: 'The exact exact text to be replaced. Must be a unique substring within the file, including exact whitespace.'
        },
        replacementContent: {
          type: 'string',
          description: 'The new content that will replace the targetContent.'
        }
      },
      required: ['targetFile', 'targetContent', 'replacementContent']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      if (!args) return 'Error: Missing arguments.'
      const parsedArgs = JSON.parse(args)
      const targetFile = parsedArgs.targetFile
      const targetContent = parsedArgs.targetContent
      const replacementContent = parsedArgs.replacementContent

      if (!targetFile) return 'Error: targetFile is required.'
      if (typeof targetContent !== 'string') return 'Error: targetContent is required and must be a string.'
      if (typeof replacementContent !== 'string') return 'Error: replacementContent is required and must be a string.'

      const absolutePath = path.resolve(context.workspaceRoot, targetFile)

      // 防御限制
      if (!absolutePath.startsWith(context.workspaceRoot)) {
        return `Error: Access denied. Cannot modify file outside of workspace.`
      }

      // 读取原文件内容
      let fileContent: string
      try {
        fileContent = await fs.readFile(absolutePath, 'utf-8')
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return `Error: File not found at ${targetFile}.`
        }
        return `Error reading file: ${err.message}`
      }

      // 统计匹配次数
      // 因为可能涉及换行符差异（\r\n vs \n），我们先统一转为 \n 处理匹配
      const normalizedFileContent = fileContent.replace(/\r\n/g, '\n')
      const normalizedTarget = targetContent.replace(/\r\n/g, '\n')

      const occurrences = normalizedFileContent.split(normalizedTarget).length - 1

      if (occurrences === 0) {
        return `Error: targetContent not found in file. Ensure exact match including whitespace and indentation.`
      }

      if (occurrences > 1) {
        return `Error: targetContent found ${occurrences} times in file. Please provide a larger block of text to make the targetContent unique.`
      }

      // 执行事务备份
      if (context.editTransactionService && context.transactionId) {
        try {
          await context.editTransactionService.backupFile(context.transactionId, absolutePath)
        } catch (backupErr: any) {
          console.error(`[ReplaceFileContentTool] Backup failed for ${absolutePath}:`, backupErr)
        }
      }

      // 替换内容
      // 保留原有系统的换行符风格（如果文件包含 \r\n，则可能在重组时要注意，但这里为了简便直接在 normalized 级别替换）
      const newContent = normalizedFileContent.replace(normalizedTarget, replacementContent.replace(/\r\n/g, '\n'))

      await fs.writeFile(absolutePath, newContent, 'utf-8')

      return `Successfully replaced content in file: ${targetFile}`
    } catch (err: any) {
      return `Error replacing file content: ${err.message}`
    }
  }
}
