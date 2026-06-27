import { Tool, ToolContext } from '../Tool'
import { ProjectAnalysisService } from '../../services/ProjectAnalysisService'
import type { SymbolMapOptions } from '../../../shared/types/project-analysis'

export class GetSymbolMapTool extends Tool {
  get name() {
    return 'get_symbol_map'
  }

  get description() {
    return 'Extract a lightweight map of symbols (classes, functions, constants, IPC names) across the workspace or a specific directory. Useful to quickly discover the APIs and structures without reading all files.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        dirPath: {
          type: 'string',
          description: 'Relative directory to analyze. Defaults to workspace root "."'
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of symbols to return. Defaults to 300.'
        }
      }
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsedArgs = args ? JSON.parse(args) as SymbolMapOptions : {}

      const service = new ProjectAnalysisService(context.workspaceRoot)
      const result = await service.getSymbolMap(parsedArgs)
      return JSON.stringify(result, null, 2)
    } catch (err: any) {
      return `Error generating symbol map: ${err.message}`
    }
  }
}
