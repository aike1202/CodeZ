import { Tool, ToolContext } from '../Tool'
import * as fs from 'fs/promises'
import * as path from 'path'

export class SearchTextTool extends Tool {
  get name() {
    return 'search_text'
  }

  get description() {
    return 'Searches for a specific text string or regex in the workspace files. To search for multiple keywords simultaneously, you can use regex OR logic (e.g., "term1|term2|term3") in the query to avoid sequential search calls.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The keyword or regex to search for (e.g., "keyword" or "keyword1|keyword2|keyword3" to search multiple keywords at once).'
        },
        dirPath: {
          type: 'string',
          description: 'The relative directory path to scope the search (default involves whole workspace). e.g., "src/main".'
        }
      },
      required: ['query']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsedArgs = args ? JSON.parse(args) : {}
      const query = parsedArgs.query
      if (!query) return 'Error: query is required.'

      const dirPath = parsedArgs.dirPath || '.'
      const searchRoot = path.resolve(context.workspaceRoot, dirPath)

      if (!searchRoot.startsWith(context.workspaceRoot)) {
        return `Error: Access denied. Cannot search outside of workspace.`
      }

      const maxResults = 50
      let results: string[] = []

      // 阶段 1：尝试原生 git grep
      try {
        const { exec } = require('child_process')
        const { promisify } = require('util')
        const execAsync = promisify(exec)
        
        // 注意转义双引号和反斜杠防止注入
        const escapedQuery = query.replace(/"/g, '\\"').replace(/\$/g, '\\$')
        const cmd = `git grep -inI -E "${escapedQuery}"`
        
        const { stdout } = await execAsync(cmd, { cwd: searchRoot, maxBuffer: 1024 * 1024 * 5 }) // 5MB buffer
        if (stdout) {
          const stdoutStr = stdout as string;
          const lines = stdoutStr.split('\n').filter((l: string) => l.trim().length > 0)
          
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= maxResults) break
            const line = lines[i]
            // git grep 格式: filename:line:content
            const match = line.match(/^([^:]+):(\d+):(.*)$/)
            if (match) {
              const relPath = dirPath === '.' ? match[1] : path.join(dirPath, match[1]).replace(/\\/g, '/')
              results.push(`${relPath}:${match[2]}: ${match[3].trim()}`)
            }
          }
          
          if (results.length > 0) {
            let out = results.join('\n')
            if (lines.length > maxResults) {
              out += '\n... (more results truncated)'
            }
            return out
          }
        }
      } catch (err: any) {
        // 如果退出码是 1，说明 git grep 执行成功但没搜到，直接返回无结果
        if (err.code === 1) {
          return `No results found for "${query}".`
        }
        // 如果是 128 (不是git仓库) 或找不到 git 等错误，则走降级逻辑
      }

      // 阶段 2：降级回退 Node.js 遍历
      // 清空可能存在的部分结果
      results = []
      
      const allowedExts = new Set([
        '.ts', '.js', '.tsx', '.jsx', '.json', '.md', '.html', '.css', '.scss', '.less',
        '.java', '.py', '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.rb',
        '.swift', '.kt', '.sql', '.sh', '.bash', '.yaml', '.yml', '.xml', '.txt'
      ])

      let totalMatchedLines = 0
      
      // 编译匹配器
      let matcher: (text: string) => boolean
      let lineMatcher: (line: string) => boolean
      try {
        const regex = new RegExp(query, 'i')
        matcher = (text) => regex.test(text)
        lineMatcher = (line) => regex.test(line)
      } catch {
        const lower = query.toLowerCase()
        matcher = (text) => text.toLowerCase().includes(lower)
        lineMatcher = (line) => line.toLowerCase().includes(lower)
      }

      async function scanAndSearch(currentDir: string) {
        if (totalMatchedLines >= maxResults) return
        try {
          const entries = await fs.readdir(currentDir, { withFileTypes: true })
          // 并发处理同级目录下的所有文件/文件夹
          await Promise.all(entries.map(async (entry) => {
            if (totalMatchedLines >= maxResults) return
            if (['node_modules', '.git', 'dist', 'out', 'build', '.next', '.nuxt', 'coverage'].includes(entry.name)) return

            const fullPath = path.join(currentDir, entry.name)
            if (entry.isDirectory()) {
              await scanAndSearch(fullPath)
            } else if (entry.isFile()) {
              const ext = path.extname(entry.name).toLowerCase()
              if (!allowedExts.has(ext)) return

              try {
                const stat = await fs.stat(fullPath)
                if (stat.size >= 500 * 1024) return // 小于 500kb
                
                const content = await fs.readFile(fullPath, 'utf8')
                if (matcher(content)) {
                  const lines = content.split('\n')
                  for (let i = 0; i < lines.length; i++) {
                    if (totalMatchedLines >= maxResults) break
                    const line = lines[i]
                    if (lineMatcher(line)) {
                      totalMatchedLines++
                      const relativePath = path.relative(context.workspaceRoot, fullPath)
                      results.push(`${relativePath}:${i + 1}: ${line.trim()}`)
                    }
                  }
                }
              } catch {
                // 忽略读取错误
              }
            }
          }))
        } catch {
          // ignore
        }
      }

      await scanAndSearch(searchRoot)

      if (results.length === 0) {
        return `No results found for "${query}".`
      }
      
      let out = results.join('\n')
      if (totalMatchedLines >= maxResults) {
        out += '\n... (more results truncated)'
      }
      return out
    } catch (err: any) {
      return `Error searching text: ${err.message}`
    }
  }
}
