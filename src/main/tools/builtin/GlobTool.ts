// src/main/tools/builtin/GlobTool.ts
import { Tool, ToolContext } from '../Tool'
import * as path from 'path'
import * as fs from 'fs/promises'
import { spawn } from 'child_process'
import fastGlob from 'fast-glob'
import { resolveRgPath } from '../ripgrepPath'

interface GlobArgs {
  pattern?: string
  path?: string
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

export class GlobTool extends Tool {
  get name() {
    return 'Glob'
  }

  get description() {
    return 'Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths (relative to workspace) sorted by modification time (newest first). Use path to scope to a subdirectory.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts".' },
        path: { type: 'string', description: 'Optional subdirectory to scope the search. Default workspace root.' }
      },
      required: ['pattern']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as GlobArgs
      if (!parsed.pattern) return 'Error: pattern is required.'

      const root = path.resolve(context.workspaceRoot, parsed.path || '.')
      const normalizedRoot = root.replace(/\\/g, '/').toLowerCase()
      const normalizedWs = context.workspaceRoot.replace(/\\/g, '/').toLowerCase()
      if (!normalizedRoot.startsWith(normalizedWs)) {
        return 'Error: Access denied. path is outside of workspace.'
      }

      let files: string[] = []
      const rgPath = resolveRgPath()
      if (rgPath) {
        try {
          files = await this.listWithRipgrep(rgPath, parsed.pattern, root)
        } catch {
          files = await this.listWithFastGlob(parsed.pattern, root)
        }
      } else {
        files = await this.listWithFastGlob(parsed.pattern, root)
      }

      if (files.length === 0) return 'No files matched.'
      return files.map(toPosix).join('\n')
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }

  private listWithRipgrep(rgPath: string, pattern: string, root: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const proc = spawn(rgPath, ['--files', '--glob', pattern, '--sortr=modified', root], { cwd: root })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (d) => { stdout += d.toString() })
      proc.stderr.on('data', (d) => { stderr += d.toString() })
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code !== 0 && stdout === '') {
          return reject(new Error(stderr || `rg exited ${code}`))
        }
        const rel = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
          .map((p) => path.relative(root, p))
        resolve(rel)
      })
    })
  }

  private async listWithFastGlob(pattern: string, root: string): Promise<string[]> {
    const matches = await fastGlob(pattern, { cwd: root, onlyFiles: true, dot: false, absolute: false })
    // 按 mtime 倒序
    const withMtime = await Promise.all(matches.map(async (p) => {
      const abs = path.join(root, p)
      const st = await fs.stat(abs).catch(() => null)
      return { p, mtime: st ? st.mtimeMs : 0 }
    }))
    withMtime.sort((a, b) => b.mtime - a.mtime)
    return withMtime.map((x) => x.p)
  }
}
