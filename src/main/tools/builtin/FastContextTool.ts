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
    return [
      'Quickly gather project context by providing an array of file or directory paths.',
      'For directories, it returns the tree structure. For files, it returns their exact contents.',
      '',
      '**When to use:** Quick lookups of 1-2 specific files or directories to understand narrow scope.',
      '',
      '**When NOT to use:** Broad "analyze the project" or "understand the architecture" requests.',
      'For cross-cutting exploration spanning 3+ files/directories, use the Task tool with Research subagent instead —',
      'that preserves your context window and returns structured evidence.',
      '',
      'Example: `fast_context(["package.json", "src/main/agent"])` — OK for understanding the agent module layout.',
      'Example: `fast_context(["package.json", "src", "README.md"])` — BAD. Delegate to Research subagent for broad analysis.'
    ].join('\n')
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
          description: 'Maximum number of characters to retain per file. Defaults to 12000 (kept below the 15000 tool-output cap to avoid truncation).'
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
