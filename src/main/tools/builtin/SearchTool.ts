import { Tool, ToolContext } from '../Tool'
import { ProjectAnalysisService } from '../../services/ProjectAnalysisService'
import * as fs from 'fs/promises'
import * as path from 'path'
import { DEFAULT_IGNORED_DIRS, DEFAULT_IGNORED_EXTENSIONS, BINARY_EXTENSIONS } from '../../../shared/constants/ignored'

interface SearchArgs {
  type: 'text' | 'file' | 'symbol'
  query: string
  dirPath?: string
  includeGlobs?: string[]
  maxResults?: number
}

type UnifiedSearchResult = {
  kind: 'file' | 'text' | 'symbol' | 'fuzzy'
  path: string
  line?: number
  column?: number
  name?: string
  preview?: string
  score?: number
  reason?: string
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
}

function shouldIgnorePathPart(part: string): boolean {
  return DEFAULT_IGNORED_DIRS.includes(part) || part.startsWith('.git')
}

function isIgnoredFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return DEFAULT_IGNORED_EXTENSIONS.includes(ext) || BINARY_EXTENSIONS.includes(ext)
}

function simpleFuzzyScore(query: string, candidate: string): number {
  const q = query.toLowerCase()
  const c = candidate.toLowerCase()
  if (!q) return 0
  if (c.includes(q)) return 100 - Math.min(c.length - q.length, 50)

  let qi = 0
  let score = 0
  let streak = 0
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      qi++
      streak++
      score += 8 + streak * 2
    } else {
      streak = 0
    }
  }
  if (qi !== q.length) return 0
  return Math.max(1, score - Math.floor(c.length / 4))
}

export class SearchTool extends Tool {
  get name() {
    return 'search'
  }

  get description() {
    return 'Unified search tool. Finds files, text content, or symbols across the workspace. Uses filesystem fallback so untracked files can be found. Returns structured matches with kind/path/line/preview/score/reason and truncated/suggestion metadata.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['text', 'file', 'symbol'],
          description: "Search type. 'text' for code/text search, 'file' to find file paths, 'symbol' for language symbols."
        },
        query: {
          type: 'string',
          description: "Search query or regex. For 'file', this matches part of the file path and can return fuzzy candidates."
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
      const query = parsedArgs.query || ''
      const queryRegex = this.createRegex(query)

      if (parsedArgs.type === 'symbol') {
        const result = await service.getSymbolMap({ dirPath: parsedArgs.dirPath, maxResults: Math.max(maxResults * 10, 1000) })
        const filteredSymbols = result.symbols.filter(s => queryRegex.test(s.name) || queryRegex.test(s.kind))
        const limited = filteredSymbols.slice(0, maxResults)
        return JSON.stringify({
          matches: limited.map<UnifiedSearchResult>(s => ({
            kind: 'symbol',
            path: s.path,
            line: s.line,
            name: s.name,
            preview: `${s.kind}: ${s.name}`,
            reason: `Matched symbol ${s.kind}`
          })),
          truncated: filteredSymbols.length > maxResults,
          suggestion: filteredSymbols.length > maxResults ? 'Refine the symbol query or dirPath to reduce results.' : undefined
        }, null, 2)
      }

      if (parsedArgs.type === 'file') {
        const files = await this.walkFiles(context.workspaceRoot, parsedArgs.dirPath || '.') 
        const exact: UnifiedSearchResult[] = []
        const fuzzy: UnifiedSearchResult[] = []

        for (const file of files) {
          if (queryRegex.test(file)) {
            exact.push({ kind: 'file', path: file, preview: file, score: 100, reason: 'Path matched query' })
          } else {
            const score = simpleFuzzyScore(query, file)
            if (score > 0) {
              fuzzy.push({ kind: 'fuzzy', path: file, preview: file, score, reason: 'Fuzzy path candidate' })
            }
          }
        }

        fuzzy.sort((a, b) => (b.score || 0) - (a.score || 0))
        const combined = [...exact, ...fuzzy]
        const limited = combined.slice(0, maxResults)
        return JSON.stringify({
          matches: limited,
          truncated: combined.length > maxResults,
          suggestion: combined.length > maxResults ? 'Refine file query or dirPath to reduce results.' : exact.length === 0 && fuzzy.length > 0 ? 'No exact path match; fuzzy candidates returned.' : undefined
        }, null, 2)
      }

      if (parsedArgs.type === 'text') {
        const fsMatches = await this.searchTextFilesystem(context.workspaceRoot, parsedArgs, maxResults)
        return JSON.stringify({
          matches: fsMatches.matches,
          truncated: fsMatches.truncated,
          suggestion: fsMatches.truncated ? 'Refine text query, includeGlobs, or dirPath to reduce results.' : undefined
        }, null, 2)
      }

      return 'Error: Invalid search type.'
    } catch (err: any) {
      return `Error in search tool: ${err.message}`
    }
  }

  private createRegex(query: string): RegExp {
    try {
      return new RegExp(query, 'i')
    } catch {
      return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }
  }

  private async walkFiles(workspaceRoot: string, dirPath: string): Promise<string[]> {
    const root = path.resolve(workspaceRoot)
    const start = path.resolve(root, dirPath)
    const normalizedRoot = root.replace(/\\/g, '/').toLowerCase()
    const normalizedStart = start.replace(/\\/g, '/').toLowerCase()
    if (!normalizedStart.startsWith(normalizedRoot)) {
      throw new Error(`Path outside workspace: ${dirPath}`)
    }

    const results: string[] = []
    const visit = async (directory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          if (!shouldIgnorePathPart(entry.name)) {
            await visit(absolute)
          }
          continue
        }
        if (!entry.isFile() || isIgnoredFile(entry.name)) continue
        results.push(toPosix(path.relative(root, absolute)))
      }
    }

    await visit(start)
    return results
  }

  private matchesAnyGlob(filePath: string, globs?: string[]): boolean {
    if (!globs || globs.length === 0) return true
    return globs.some((glob) => {
      const normalized = glob.replace(/\\/g, '/')
      if (normalized.startsWith('*.')) return filePath.endsWith(normalized.slice(1))
      if (normalized.includes('**/*')) return filePath.endsWith(normalized.split('**/*')[1])
      return filePath.includes(normalized.replace('*', ''))
    })
  }

  private async searchTextFilesystem(workspaceRoot: string, args: SearchArgs, maxResults: number): Promise<{ matches: UnifiedSearchResult[]; truncated: boolean }> {
    const files = await this.walkFiles(workspaceRoot, args.dirPath || '.')
    const queryRegex = this.createRegex(args.query)
    const matches: UnifiedSearchResult[] = []
    let truncated = false

    for (const relativePath of files) {
      if (!this.matchesAnyGlob(relativePath, args.includeGlobs)) continue
      const absolute = path.join(workspaceRoot, relativePath)
      const stat = await fs.stat(absolute).catch(() => null)
      if (!stat || stat.size > 5 * 1024 * 1024) continue

      const buffer = await fs.readFile(absolute).catch(() => null)
      if (!buffer || buffer.subarray(0, 512).includes(0)) continue

      const lines = buffer.toString('utf-8').split('\n')
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        queryRegex.lastIndex = 0
        const match = queryRegex.exec(line)
        if (!match) continue
        matches.push({
          kind: 'text',
          path: relativePath,
          line: index + 1,
          column: match.index + 1,
          preview: line.trim(),
          reason: 'Text matched query'
        })
        if (matches.length >= maxResults) {
          truncated = true
          return { matches, truncated }
        }
      }
    }

    return { matches, truncated }
  }
}
