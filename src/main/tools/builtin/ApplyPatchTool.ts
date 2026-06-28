import { Tool, ToolContext } from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'

interface PatchEdit {
  targetContent: string
  replacementContent: string
}

interface ApplyPatchArgs {
  filePath: string
  expectedHash?: string
  edits?: PatchEdit[]
  fullOverwrite?: boolean
  newContent?: string
}

export class ApplyPatchTool extends Tool {
  get name() {
    return 'apply_patch'
  }

  get description() {
    return 'The unified writing tool for modifying or creating files. You can provide multiple search-replace blocks (edits) for partial modifications, or fullOverwrite for replacing the whole file. MUST provide expectedHash (obtained from read_files) to ensure you are editing the latest version.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Relative path of the file to modify or create.'
        },
        expectedHash: {
          type: 'string',
          description: 'The SHA256 hash of the file before your edit. Obtain this by calling read_files. Mandatory for existing files to prevent conflict.'
        },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              targetContent: { type: 'string', description: 'Exact text to find. Must be unique.' },
              replacementContent: { type: 'string', description: 'Text to replace it with.' }
            },
            required: ['targetContent', 'replacementContent']
          },
          description: 'Array of search-replace blocks for partial updates.'
        },
        fullOverwrite: {
          type: 'boolean',
          description: 'If true, replaces the entire file with newContent (or creates it if it does not exist).'
        },
        newContent: {
          type: 'string',
          description: 'The new full content. Required if fullOverwrite is true.'
        }
      },
      required: ['filePath']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsedArgs = JSON.parse(args) as ApplyPatchArgs
      const { filePath, expectedHash, edits, fullOverwrite, newContent } = parsedArgs

      if (!filePath) return 'Error: filePath is required.'
      
      const absolutePath = path.resolve(context.workspaceRoot, filePath)
      if (!absolutePath.replace(/\\/g, '/').toLowerCase().startsWith(context.workspaceRoot.replace(/\\/g, '/').toLowerCase())) {
        return `Error: Access denied. Cannot modify file outside of workspace.`
      }

      let fileExists = true
      let fileContent = ''
      try {
        const buffer = await fs.readFile(absolutePath)
        fileContent = buffer.toString('utf-8')
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          fileExists = false
        } else {
          return `Error reading file: ${err.message}`
        }
      }

      // 强校验预期 Hash
      if (fileExists && expectedHash) {
        const actualHash = createHash('sha256').update(fileContent).digest('hex')
        if (actualHash !== expectedHash) {
          return `Error: Hash mismatch! Expected ${expectedHash}, but file hash is ${actualHash}. The file has been modified recently. Please call read_files to get the latest content and hash before patching.`
        }
      } else if (fileExists && !fullOverwrite && !expectedHash) {
         return `Error: expectedHash is missing. You MUST provide the expectedHash of the existing file to safely patch it.`
      }

      let updatedContent = fileContent

      if (fullOverwrite) {
        if (typeof newContent !== 'string') {
          return 'Error: newContent is required when fullOverwrite is true.'
        }
        updatedContent = newContent
      } else if (edits && Array.isArray(edits)) {
        if (!fileExists) {
          return 'Error: Cannot apply partial edits to a non-existent file. Use fullOverwrite to create it.'
        }
        
        let tempContent = fileContent.replace(/\r\n/g, '\n')
        
        for (let i = 0; i < edits.length; i++) {
          const edit = edits[i]
          const target = edit.targetContent.replace(/\r\n/g, '\n')
          const occurrences = tempContent.split(target).length - 1
          
          if (occurrences === 0) {
            return `Error in edit block ${i + 1}: targetContent not found. Ensure exact match including whitespaces.`
          }
          if (occurrences > 1) {
            return `Error in edit block ${i + 1}: targetContent is not unique (${occurrences} matches). Please expand the target text.`
          }
          
          tempContent = tempContent.replace(target, edit.replacementContent.replace(/\r\n/g, '\n'))
        }
        updatedContent = tempContent
      } else {
        return 'Error: You must provide either fullOverwrite=true (with newContent) or an array of edits.'
      }

      // 执行事务备份
      if (context.editTransactionService && context.transactionId) {
        try {
          if (fileExists) {
            await context.editTransactionService.backupFile(context.transactionId, absolutePath)
          }
        } catch (backupErr: any) {
          console.error(`[ApplyPatchTool] Backup failed for ${absolutePath}:`, backupErr)
        }
      }

      // 写入文件前确保目录存在
      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.writeFile(absolutePath, updatedContent, 'utf-8')

      return `Successfully applied patch to: ${filePath}`
    } catch (err: any) {
      return `Error in apply_patch: ${err.message}`
    }
  }
}
