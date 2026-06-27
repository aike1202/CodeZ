import { Tool, ToolContext } from '../Tool'
import { ProjectAnalysisService } from '../../services/ProjectAnalysisService'
import type { ProjectSnapshotOptions } from '../../../shared/types/project-analysis'

export class GetProjectSnapshotTool extends Tool {
  get name() {
    return 'get_project_snapshot'
  }

  get description() {
    return 'Analyze the current workspace in one call. Use this first when the user asks to analyze, understand, summarize, or inspect the project architecture. It returns project type, package scripts, dependencies, directory tree, entrypoints, and recommended files to read next.'
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
          description: 'An array of relative directory paths to analyze (e.g., ["src/main", "src/renderer"]). If provided, dirPath is ignored.'
        },
        dirPath: {
          type: 'string',
          description: 'Relative directory to analyze. Defaults to workspace root ".".'
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum directory tree depth. Defaults to 3.'
        },
        includeFiles: {
          type: 'boolean',
          description: 'Whether to include files in the directory tree. Defaults to true.'
        },
        forceRefresh: {
          type: 'boolean',
          description: 'Force rebuilding the project snapshot instead of using cache.'
        }
      }
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsedArgs = args ? JSON.parse(args) as ProjectSnapshotOptions : {}
      const service = new ProjectAnalysisService(context.workspaceRoot)
      const snapshot = await service.getProjectSnapshot(parsedArgs)
      return JSON.stringify(snapshot, null, 2)
    } catch (err: any) {
      return `Error getting project snapshot: ${err.message}`
    }
  }
}
