import { Tool, ToolContext } from '../Tool'
import { ProjectAnalysisService } from '../../services/ProjectAnalysisService'

interface ReadManyFilesArgs {
  filePaths: string[]
  maxCharsPerFile?: number
}

export class ReadManyFilesTool extends Tool {
  get name() {
    return 'read_files'
  }

  get description() {
    return 'Read the contents of multiple files in a single call. Much faster than using read_file repeatedly. Supports truncation for large files.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        filePaths: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'An array of relative file paths to read. Example: ["package.json", "src/main/index.ts"]'
        },
        maxCharsPerFile: {
          type: 'number',
          description: 'Maximum number of characters to retain per file. Defaults to 40000.'
        }
      },
      required: ['filePaths']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsedArgs = JSON.parse(args) as ReadManyFilesArgs
      if (!parsedArgs.filePaths || !Array.isArray(parsedArgs.filePaths)) {
        return 'Error: filePaths is required and must be an array.'
      }

      const service = new ProjectAnalysisService(context.workspaceRoot)
      const result = await service.readManyFiles(parsedArgs.filePaths, parsedArgs.maxCharsPerFile)
      return JSON.stringify(result, null, 2)
    } catch (err: any) {
      return `Error reading multiple files: ${err.message}`
    }
  }
}
