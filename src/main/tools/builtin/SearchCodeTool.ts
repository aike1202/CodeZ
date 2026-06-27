import { Tool, ToolContext } from '../Tool'
import { ProjectAnalysisService } from '../../services/ProjectAnalysisService'
import type { SearchCodeOptions } from '../../../shared/types/project-analysis'

export class SearchCodeTool extends Tool {
  get name() {
    return 'search_code'
  }

  get description() {
    return 'Search for code/text across the workspace. Returns matching lines along with surrounding context. To search for multiple terms simultaneously, you can use regular expression OR logic (e.g., "term1|term2|term3") in the query to avoid making multiple sequential search calls.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query string or regex pattern (e.g., "keyword" or "keyword1|keyword2|keyword3" to search multiple keywords at once).'
        },
        dirPath: {
          type: 'string',
          description: 'Relative directory to search in. Defaults to workspace root "."'
        },
        includeGlobs: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'Optional glob patterns for filtering files. Example: ["*.ts", "**/*.tsx"]'
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results to return. Defaults to 80.'
        },
        contextLines: {
          type: 'number',
          description: 'Number of lines of context to include before and after the match. Defaults to 2.'
        }
      },
      required: ['query']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsedArgs = JSON.parse(args) as SearchCodeOptions
      if (!parsedArgs.query) {
        return 'Error: query is required.'
      }

      const service = new ProjectAnalysisService(context.workspaceRoot)
      const result = await service.searchCode(parsedArgs)
      return JSON.stringify(result, null, 2)
    } catch (err: any) {
      return `Error searching code: ${err.message}`
    }
  }
}
