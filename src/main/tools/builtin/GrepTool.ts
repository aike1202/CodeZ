// src/main/tools/builtin/GrepTool.ts
import { Tool, ToolContext } from '../Tool'
import * as path from 'path'
import { spawn } from 'child_process'
import { resolveRgPath } from '../ripgrepPath'

interface GrepArgs {
  pattern?: string
  path?: string
  output_mode?: 'files_with_matches' | 'content' | 'count'
  glob?: string
  type?: string
  '-A'?: number
  '-B'?: number
  '-C'?: number
  '-n'?: boolean
  '-i'?: boolean
  '-o'?: boolean
  multiline?: boolean
  head_limit?: number
  offset?: number
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

export class GrepTool extends Tool {
  get name() {
    return 'Grep'
  }

  get summary() {
    return 'Search file contents with regex patterns.'
  }

  get description() {
    return 'Content search built on ripgrep. Prefer this over grep/rg via Bash — results integrate with the permission UI and file links. Full regex syntax (e.g. "log.*Error", "function\\s+\\w+"); escape literal braces. path scopes the search to a subdirectory (default workspace root). Filter with glob (e.g. "**/*.tsx") or type (e.g. "js", "py", "rust"). output_mode: "files_with_matches" (default, paths only), "content" (matching lines), or "count". Use -n for line numbers, -A/-B/-C for after/before/context lines, -i for case-insensitive, -o for matching part only. multiline: true for patterns that span lines. head_limit and offset paginate results.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'Optional subdirectory to scope the search. Default workspace root.' },
        output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'], description: 'Default files_with_matches.' },
        glob: { type: 'string', description: 'Glob filter, e.g. "**/*.tsx".' },
        type: { type: 'string', description: 'File type filter, e.g. "rust", "js".' },
        '-A': { type: 'number', description: 'Lines of context after each match.' },
        '-B': { type: 'number', description: 'Lines of context before each match.' },
        '-C': { type: 'number', description: 'Lines of context around each match.' },
        '-n': { type: 'boolean', description: 'Show line numbers (content mode).' },
        '-i': { type: 'boolean', description: 'Case-insensitive.' },
        '-o': { type: 'boolean', description: 'Print only matched parts.' },
        multiline: { type: 'boolean', description: 'Enable multiline matching.' },
        head_limit: { type: 'number', description: 'Maximum result entries to return.' },
        offset: { type: 'number', description: 'Skip first N result entries.' }
      },
      required: ['pattern']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as GrepArgs
      if (!parsed.pattern) return 'Error: pattern is required.'

      const rgPath = resolveRgPath()
      if (!rgPath) return 'Error: ripgrep is not available (rgPath could not be resolved).'

      const root = path.resolve(context.workspaceRoot, parsed.path || '.')
      const normalizedRoot = root.replace(/\\/g, '/').toLowerCase()
      const normalizedWs = context.workspaceRoot.replace(/\\/g, '/').toLowerCase()
      if (!normalizedRoot.startsWith(normalizedWs)) {
        return 'Error: Access denied. path is outside of workspace.'
      }

      const mode = parsed.output_mode || 'files_with_matches'
      const rgArgs: string[] = ['--no-heading', '--color', 'never']
      if (mode === 'files_with_matches') rgArgs.push('-l')
      else if (mode === 'count') rgArgs.push('-c')
      else { if (parsed['-n']) rgArgs.push('-n'); if (parsed['-o']) rgArgs.push('-o') }
      if (parsed['-A']) rgArgs.push('-A', String(parsed['-A']))
      if (parsed['-B']) rgArgs.push('-B', String(parsed['-B']))
      if (parsed['-C']) rgArgs.push('-C', String(parsed['-C']))
      if (parsed['-i']) rgArgs.push('-i')
      if (parsed.multiline) rgArgs.push('--multiline')
      if (parsed.glob) rgArgs.push('--glob', parsed.glob)
      if (parsed.type) rgArgs.push('--type', parsed.type)
      rgArgs.push('--', parsed.pattern, root)

      const { stdout, code, error } = await this.runRg(rgPath, rgArgs, root)
      if (error) return `Error: ripgrep failed to start: ${error}`

      if (code !== 0 && code !== 1) {
        return `Error: ripgrep exited with code ${code}.`
      }

      let lines = stdout.split('\n').filter((l) => l.length > 0)
      // rg --files / content 路径相对 root；统一为相对 workspace
      lines = lines.map((l) => this.relativize(l, root, context.workspaceRoot))
      if (parsed.offset && parsed.offset > 0) lines = lines.slice(parsed.offset)
      if (parsed.head_limit && parsed.head_limit > 0) lines = lines.slice(0, parsed.head_limit)

      if (lines.length === 0) return 'No matches found.'
      return lines.map(toPosix).join('\n')
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }

  private runRg(rgPath: string, rgArgs: string[], cwd: string): Promise<{ stdout: string; code: number | null; error?: string }> {
    return new Promise((resolve) => {
      const proc = spawn(rgPath, rgArgs, { cwd })
      let stdout = ''
      let err = ''
      proc.stdout.on('data', (d) => { stdout += d.toString() })
      proc.stderr.on('data', (d) => { err += d.toString() })
      proc.on('error', (e) => resolve({ stdout: '', code: null, error: e.message }))
      proc.on('close', (code) => resolve({ stdout, code: code ?? 0 }))
    })
  }

  /** rg 输出可能是绝对路径或 `./rel` 形式；转为相对 workspace 的 posix 路径前缀（保留 content 模式的 :line:col 部分）。 */
  private relativize(line: string, root: string, workspaceRoot: string): string {
    // content/count 行形如 `<path>:<n>:...` 或 `<path>:<n>`；path 可能是绝对或相对
    const sep = line.indexOf(':')
    if (sep < 0) return line
    let p = line.slice(0, sep)
    if (path.isAbsolute(p)) {
      p = path.relative(workspaceRoot, p)
    } else if (p.startsWith('./')) {
      p = p.slice(2)
    } else {
      p = path.relative(workspaceRoot, path.resolve(root, p))
    }
    return `${p}${line.slice(sep)}`
  }
}
