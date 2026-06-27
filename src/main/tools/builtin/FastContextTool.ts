import { Tool, ToolContext } from '../Tool'
import { ProjectAnalysisService } from '../../services/ProjectAnalysisService'

interface FastContextArgs {
  targetPaths: string[]
  maxDepth?: number
  maxCharsPerFile?: number
}

export class FastContextTool extends Tool {
  get name() {
    return 'fast_context'
  }

  get description() {
    return 'Quickly gather project context by providing an array of file or directory paths. For directories, it returns the tree structure. For files, it returns their exact contents. Use this tool for a rapid understanding of specific components. (e.g. ["src", "pom.xml", "README.md"])'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        targetPaths: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'An array of relative file or directory paths to read. Example: ["src/renderer", "package.json"]'
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum directory tree depth if a target is a directory. Defaults to 2.'
        },
        maxCharsPerFile: {
          type: 'number',
          description: 'Maximum number of characters to retain per file. Defaults to 15000.'
        }
      },
      required: ['targetPaths']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsedArgs = JSON.parse(args) as FastContextArgs
      if (!parsedArgs.targetPaths || !Array.isArray(parsedArgs.targetPaths)) {
        return 'Error: targetPaths is required and must be an array.'
      }

      const service = new ProjectAnalysisService(context.workspaceRoot)
      const result = await service.getFastContext(
        parsedArgs.targetPaths,
        parsedArgs.maxDepth,
        parsedArgs.maxCharsPerFile
      )
      
      if (!result) {
        return 'No content could be retrieved.'
      }
      
      return result
    } catch (err: any) {
      return `Error gathering fast context: ${err.message}`
    }
  }
}
