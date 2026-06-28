import { Tool, ToolContext } from '../Tool'
import { ProjectAnalysisService } from '../../services/ProjectAnalysisService'
import * as path from 'path'

interface SearchArgs {
  type: 'text' | 'file' | 'symbol'
  query: string
  dirPath?: string
  includeGlobs?: string[]
  maxResults?: number
}

export class SearchTool extends Tool {
  get name() {
    return 'search'
  }

  get description() {
    return 'Unified search tool. Finds files, text content, or symbols across the workspace. Use type="text" for regex text search, type="file" to find file paths, type="symbol" for classes/functions/variables.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['text', 'file', 'symbol'],
          description: "Search type. 'text' for code/text search, 'file' to find file names matching query, 'symbol' for language symbols."
        },
        query: {
          type: 'string',
          description: "Search query or regex. For 'file', this matches part of the file path."
        },
        dirPath: {
          type: 'string',
          description: "Relative directory path to scope the search. Default is '.'"
        },
        includeGlobs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional glob patterns for text search. Example: ["*.ts", "**/*.tsx"]'
        },
        maxResults: {
          type: 'number',
          description: "Max results to return. Defaults to 50."
        }
      },
      required: ['type', 'query']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsedArgs = JSON.parse(args) as SearchArgs
      const service = new ProjectAnalysisService(context.workspaceRoot)
      const maxResults = parsedArgs.maxResults || 50
      const queryRegex = new RegExp(parsedArgs.query, 'i')

      if (parsedArgs.type === 'symbol') {
        const result = await service.getSymbolMap({ dirPath: parsedArgs.dirPath, maxResults: 1000 })
        const filteredSymbols = result.symbols.filter(s => queryRegex.test(s.name) || queryRegex.test(s.kind))
        const limited = filteredSymbols.slice(0, maxResults)
        return JSON.stringify({ 
          matches: limited.map(s => ({ path: s.path, line: s.line, name: s.name, kind: s.kind })), 
          truncated: filteredSymbols.length > maxResults 
        }, null, 2)
      }

      if (parsedArgs.type === 'file') {
        const dir = parsedArgs.dirPath || '.'
        const searchRoot = service.validatePath(dir)
        const results: any[] = []
        let truncated = false

        try {
          const { exec } = require('child_process')
          const { promisify } = require('util')
          const execAsync = promisify(exec)
          const { stdout } = await execAsync(`git ls-files`, { cwd: searchRoot, maxBuffer: 1024 * 1024 * 5 })
          if (stdout) {
            const lines = (stdout as string).split('\n')
            for (const line of lines) {
              if (!line) continue
              if (queryRegex.test(line)) {
                results.push({ path: line })
                if (results.length >= maxResults) {
                  truncated = true
                  break
                }
              }
            }
            return JSON.stringify({ matches: results, truncated }, null, 2)
          }
        } catch {
          // Fallback missing for brevity; usually git ls-files works in valid repos.
          return JSON.stringify({ error: 'Failed to list files. Ensure this is a git repository.' })
        }
      }

      if (parsedArgs.type === 'text') {
        const dirPath = parsedArgs.dirPath || '.'
        const searchRoot = service.validatePath(dirPath)
        const results: any[] = []
        let truncated = false

        try {
          const { exec } = require('child_process')
          const { promisify } = require('util')
          const execAsync = promisify(exec)
          
          const escapedQuery = parsedArgs.query.replace(/"/g, '\\"').replace(/\\/g, '\\\\').replace(/\$/g, '\\$')
          const cmd = `git grep -inI -E "${escapedQuery}"`
          const { stdout } = await execAsync(cmd, { cwd: searchRoot, maxBuffer: 1024 * 1024 * 5 })
          
          if (stdout) {
            const lines = (stdout as string).split('\n').filter((l: string) => l.trim().length > 0)
            for (let i = 0; i < lines.length; i++) {
              if (results.length >= maxResults) {
                truncated = true
                break
              }
              const match = lines[i].match(/^([^:]+):(\d+):(.*)$/)
              if (match) {
                results.push({
                  path: match[1],
                  line: parseInt(match[2], 10),
                  text: match[3].trim()
                })
              }
            }
            return JSON.stringify({ matches: results, truncated }, null, 2)
          }
        } catch (err: any) {
          if (err.code === 1) {
            return JSON.stringify({ matches: [], message: `No results found for "${parsedArgs.query}".` })
          }
        }
        
        // Fallback to service.searchCode
        const codeResult = await service.searchCode({
          query: parsedArgs.query,
          dirPath: parsedArgs.dirPath,
          includeGlobs: parsedArgs.includeGlobs,
          maxResults
        })
        const mappedMatches = codeResult.matches.map(m => ({
          path: m.path,
          line: m.line,
          text: m.text
        }))
        return JSON.stringify({ matches: mappedMatches, truncated: codeResult.truncated }, null, 2)
      }

      return 'Error: Invalid search type.'
    } catch (err: any) {
      return `Error in search tool: ${err.message}`
    }
  }
}
