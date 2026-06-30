### Task 5: Glob 工具（@vscode/ripgrep --files + fast-glob 回退，按 mtime 排序）

**Files:**
- Create: `src/main/tools/builtin/GlobTool.ts`
- Modify: `package.json`（新增依赖 `@vscode/ripgrep` 与 `fast-glob`）
- Test: `src/tests/glob-tool.test.ts`

**Interfaces:**
- Consumes: `@vscode/ripgrep`（`rgPath`）、`fast-glob`（回退）。`Tool`/`ToolContext`。
- Produces: `class GlobTool extends Tool`，`name='Glob'`，`parameters_schema={pattern(req), path?}`。返回匹配路径列表（每行一条，相对 workspace，按 mtime 倒序）。`Error: ...` 当 pattern 缺失。ripgrep 不可用时回退 `fast-glob`（不抛错）；二者都不行才报错。
- 解析 ripgrep 路径：优先 `process.env.CODEZ_RG_PATH`（测试用），否则 `require('@vscode/ripgrep').rgPath`。

**说明：** `@vscode/ripgrep` 与 `fast-glob` 当前均未安装（已核验 package.json），本任务一并加入。`list_files` 仍保留不动（不在本任务触碰）。

- [ ] **Step 1: Write the failing test**

```ts
// src/tests/glob-tool.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { GlobTool } from '../main/tools/builtin/GlobTool'

let root: string

async function setup(): Promise<string> {
  root = path.join(os.tmpdir(), `codez-glob-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
  await fs.writeFile(path.join(root, 'src', 'b.ts'), 'export const b = 2\n')
  await fs.writeFile(path.join(root, 'README.md'), '# readme\n')
  return root
}

describe('GlobTool', () => {
  beforeEach(async () => { await setup() })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

  it('pattern **/*.ts 命中 TS 文件', async () => {
    const tool = new GlobTool()
    const result = await tool.execute(JSON.stringify({ pattern: '**/*.ts' }), { workspaceRoot: root })
    const lines = result.split('\n').filter(Boolean)
    expect(lines).toEqual(expect.arrayContaining([
      path.join('src', 'a.ts').replace(/\\/g, '/'),
      path.join('src', 'b.ts').replace(/\\/g, '/')
    ]))
    expect(lines.some((l) => l.endsWith('README.md'))).toBe(false)
  })

  it('path 指定子目录：仅该子树匹配', async () => {
    const tool = new GlobTool()
    const result = await tool.execute(JSON.stringify({ pattern: '**/*.ts', path: 'src' }), { workspaceRoot: root })
    const lines = result.split('\n').filter(Boolean)
    expect(lines.length).toBe(2)
  })

  it('缺 pattern：返错', async () => {
    const tool = new GlobTool()
    const result = await tool.execute(JSON.stringify({}), { workspaceRoot: root })
    expect(result.startsWith('Error:')).toBe(true)
  })

  it('ripgrep 不可用时回退 fast-glob 返回一致结果', async () => {
    process.env.CODEZ_RG_PATH = path.join(root, 'no-such-rg-binary')
    try {
      const tool = new GlobTool()
      const result = await tool.execute(JSON.stringify({ pattern: '**/*.ts' }), { workspaceRoot: root })
      const lines = result.split('\n').filter(Boolean)
      expect(lines.length).toBe(2)
    } finally {
      delete process.env.CODEZ_RG_PATH
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/glob-tool.test.ts`
Expected: FAIL，`Cannot find module '../main/tools/builtin/GlobTool'`（且依赖未装）。

- [ ] **Step 3: Install dependencies**

Run:
```bash
npm install @vscode/ripgrep fast-glob
```
Expected: 两个包写入 `package.json` dependencies，`@vscode/ripgrep` 下载平台 ripgrep 二进制。再安装类型：
```bash
npm install -D @types/fast-glob
```

- [ ] **Step 4: Write minimal implementation**

```ts
// src/main/tools/builtin/GlobTool.ts
import { Tool, ToolContext } from '../Tool'
import * as path from 'path'
import * as fs from 'fs/promises'
import { spawn } from 'child_process'
import fastGlob from 'fast-glob'

interface GlobArgs {
  pattern?: string
  path?: string
}

function resolveRgPath(): string | null {
  if (process.env.CODEZ_RG_PATH) return process.env.CODEZ_RG_PATH
  try {
    // @vscode/ripgrep 导出 rgPath 字符串
    const mod = require('@vscode/ripgrep')
    return mod && mod.rgPath ? mod.rgPath : null
  } catch {
    return null
  }
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/tests/glob-tool.test.ts`
Expected: PASS（4 例全绿；含 ripgrep 不可用回退）。

- [ ] **Step 6: Commit**

```bash
git add src/main/tools/builtin/GlobTool.ts src/tests/glob-tool.test.ts package.json package-lock.json
git commit -m "feat(tools): add Glob tool (ripgrep --files with fast-glob fallback, mtime sort)"
```
