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
    return 'The unified writing tool for modifying or creating files. For existing files, you MUST first call read_files and provide expectedHash. Use edits for exact unique search-replace blocks, or fullOverwrite with newContent for creating files or replacing small files. Returns changedFiles, diff, summary, and file hashes. \n\nIMPORTANT SECURITY BEHAVIOR: Do NOT ask for user permission via conversational text before calling this tool. The system has a built-in Permission Manager that will automatically intercept file modifications and prompt the user with a native intuitive UI approval card. Therefore, you must invoke this tool directly, silently, and immediately whenever a file needs to be patched or created. Trust the UI and let the Permission Manager do its job.'
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
          description: 'The SHA256 hash of the existing file before your edit. Obtain this by calling read_files. Mandatory for all existing files, including fullOverwrite.'
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
          description: 'If true, replaces the entire file with newContent (or creates it if it does not exist). Existing files still require expectedHash.'
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
      const normalizedTarget = absolutePath.replace(/\\/g, '/').toLowerCase()
      const normalizedRoot = context.workspaceRoot.replace(/\\/g, '/').toLowerCase()
      if (!normalizedTarget.startsWith(normalizedRoot)) {
        return `Error: Access denied. Cannot modify file outside of workspace.`
      }

      let fileExists = true
      let fileContent = ''
      let beforeHash: string | undefined
      try {
        const buffer = await fs.readFile(absolutePath)
        fileContent = buffer.toString('utf-8')
        beforeHash = createHash('sha256').update(buffer).digest('hex')
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          fileExists = false
        } else {
          return `Error reading file: ${err.message}`
        }
      }

      // 强校验预期 Hash：所有已有文件修改都必须带 expectedHash，包含 fullOverwrite。
      if (fileExists) {
        if (!expectedHash) {
          return `Error: expectedHash is missing. You MUST provide the expectedHash of the existing file by calling read_files before patching.`
        }
        if (beforeHash !== expectedHash) {
          return `Error: Hash mismatch! Expected ${expectedHash}, but file hash is ${beforeHash}. The file has been modified recently. Please call read_files to get the latest content and hash before patching.`
        }
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
        if (edits.length === 0) {
          return 'Error: edits must contain at least one edit block.'
        }
        
        let tempContent = fileContent.replace(/\r\n/g, '\n')
        
        for (let i = 0; i < edits.length; i++) {
          const edit = edits[i]
          const target = edit.targetContent.replace(/\r\n/g, '\n')
          const occurrences = tempContent.split(target).length - 1
          
          if (occurrences === 0) {
            return `Error in edit block ${i + 1}: targetContent not found. Ensure exact match including whitespaces. Re-read the relevant range before retrying.`
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

      // 执行事务备份。新建文件也必须记录，以便 Reject 时删除。
      if (context.editTransactionService && context.transactionId) {
        try {
          await context.editTransactionService.backupFile(context.transactionId, absolutePath)
        } catch (backupErr: any) {
          return `Error: Failed to backup file before writing: ${backupErr.message}`
        }
      }

      // 写入文件前确保目录存在
      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.writeFile(absolutePath, updatedContent, 'utf-8')

      const afterHash = createHash('sha256').update(updatedContent).digest('hex')
      let diff = ''
      if (context.editTransactionService && context.transactionId) {
        try {
          const diffs = await context.editTransactionService.getDiff(context.transactionId)
          const currentDiff = diffs.find((item) => item.path === absolutePath)
          diff = currentDiff?.diff || ''
        } catch {
          diff = ''
        }
      }

      const output = {
        changedFiles: [filePath],
        diff,
        summary: `${fileExists ? 'Modified' : 'Created'} ${filePath}`,
        fileHashBefore: beforeHash,
        fileHashAfter: afterHash
      }

      return JSON.stringify(output, null, 2)
    } catch (err: any) {
      return `Error in apply_patch: ${err.message}`
    }
  }
}
