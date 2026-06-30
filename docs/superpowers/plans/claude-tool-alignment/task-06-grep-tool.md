### Task 6: Grep 工具（ripgrep 子进程；files_with_matches/content/count + 全集参数）

**Files:**
- Create: `src/main/tools/builtin/GrepTool.ts`
- Test: `src/tests/grep-tool.test.ts`

**Interfaces:**
- Consumes: `@vscode/ripgrep`（`rgPath`，Task 5 已装）；`Tool`/`ToolContext`。
- Produces: `class GrepTool extends Tool`，`name='Grep'`，参数 schema：`pattern(req), path?, output_mode?('files_with_matches'|'content'|'count'), glob?, type?, -A?, -B?, -C?, -n?, -i?, -o?, multiline?, head_limit?, offset?`。返回文本：`files_with_matches`→每行一个路径；`content`→`path:line:column:lineText` 或带上下文块；`count`→`path:count`。ripgrep 不可用→`Error: ripgrep not available...`（不回退纯 JS）。
- 解析 ripgrep 路径同 Glob：`process.env.CODEZ_RG_PATH` 优先，否则 `require('@vscode/ripgrep').rgPath`。
- ripgrep 退出码：0=有匹配，1=无匹配（空结果，非错误），2=错误。

**说明：** `search` type=text 的 alias 委托已在 Task 16 删除旧 `search` 工具时一并处理；本任务只做新 `Grep`。

- [ ] **Step 1: Write the failing test**

```ts
// src/tests/grep-tool.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { GrepTool } from '../main/tools/builtin/GrepTool'

let root: string

async function setup(): Promise<string> {
  root = path.join(os.tmpdir(), `codez-grep-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'const log = 1\nfunction foo() { return log + 1 }\n')
  await fs.writeFile(path.join(root, 'src', 'b.tsx'), 'export const Bar = () => null\n')
  await fs.writeFile(path.join(root, 'multi.txt'), 'start\nspan\nend\n')
  return root
}

describe('GrepTool', () => {
  beforeEach(async () => { await setup() })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

  it('files_with_matches：返回命中路径', async () => {
    const tool = new GrepTool()
    const result = await tool.execute(JSON.stringify({ pattern: 'log', output_mode: 'files_with_matches' }), { workspaceRoot: root })
    const lines = result.split('\n').filter(Boolean)
    expect(lines.some((l) => l.replace(/\\/g, '/').endsWith('src/a.ts'))).toBe(true)
    expect(lines.some((l) => l.replace(/\\/g, '/').endsWith('src/b.tsx'))).toBe(false)
  })

  it('content + -n:true：返回带行号的匹配行', async () => {
    const tool = new GrepTool()
    const result = await tool.execute(JSON.stringify({ pattern: 'foo', output_mode: 'content', '-n': true }), { workspaceRoot: root })
    expect(result).toContain('foo')
    expect(result).toMatch(/\b2\b/) // 第二行
  })

  it('glob 过滤生效', async () => {
    const tool = new GrepTool()
    const result = await tool.execute(JSON.stringify({ pattern: '.', output_mode: 'files_with_matches', glob: '**/*.tsx' }), { workspaceRoot: root })
    const lines = result.split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
    expect(lines[0].replace(/\\/g, '/').endsWith('src/b.tsx')).toBe(true)
  })

  it('-A/-B 上下文出现', async () => {
    const tool = new GrepTool()
    const result = await tool.execute(JSON.stringify({ pattern: 'span', output_mode: 'content', '-A': 1, '-B': 1 }), { workspaceRoot: root })
    expect(result).toContain('start')
    expect(result).toContain('span')
    expect(result).toContain('end')
  })

  it('head_limit 限制输出条数', async () => {
    const tool = new GrepTool()
    const result = await tool.execute(JSON.stringify({ pattern: '.', output_mode: 'files_with_matches', head_limit: 1 }), { workspaceRoot: root })
    const lines = result.split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
  })

  it('ripgrep 不可用：返错（不回退纯 JS）', async () => {
    process.env.CODEZ_RG_PATH = path.join(root, 'no-such-rg')
    try {
      const tool = new GrepTool()
      const result = await tool.execute(JSON.stringify({ pattern: 'log' }), { workspaceRoot: root })
      expect(result.startsWith('Error:')).toBe(true)
      expect(result).toContain('ripgrep')
    } finally {
      delete process.env.CODEZ_RG_PATH
    }
  })

  it('缺 pattern：返错', async () => {
    const tool = new GrepTool()
    const result = await tool.execute(JSON.stringify({}), { workspaceRoot: root })
    expect(result.startsWith('Error:')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/grep-tool.test.ts`
Expected: FAIL，`Cannot find module '../main/tools/builtin/GrepTool'`。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/tools/builtin/GrepTool.ts
import { Tool, ToolContext } from '../Tool'
import * as path from 'path'
import { spawn } from 'child_process'

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

function resolveRgPath(): string | null {
  if (process.env.CODEZ_RG_PATH) return process.env.CODEZ_RG_PATH
  try {
    const mod = require('@vscode/ripgrep')
    return mod && mod.rgPath ? mod.rgPath : null
  } catch {
    return null
  }
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

export class GrepTool extends Tool {
  get name() {
    return 'Grep'
  }

  get description() {
    return 'Content search built on ripgrep. Prefer this over grep/rg via Bash. Full regex syntax (e.g. "log.*Error", "function\\s+\\w+"); escape literal braces. Filter with glob or type. output_mode: "files_with_matches" (default, paths only), "content" (matching lines, add -n for line numbers, -A/-B/-C for context), or "count". multiline:true for patterns spanning lines. head_limit/offset paginate results.'
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/grep-tool.test.ts`
Expected: PASS（7 例全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/builtin/GrepTool.ts src/tests/grep-tool.test.ts
git commit -m "feat(tools): add Grep tool (ripgrep subprocess, full Claude param set)"
```
