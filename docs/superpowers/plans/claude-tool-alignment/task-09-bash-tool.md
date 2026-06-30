### Task 9: Bash 工具（Git Bash 优先→spawn bash 回退；前台/background/timeout/工作目录持久）

**Files:**
- Create: `src/main/tools/builtin/BashTool.ts`
- Test: `src/tests/bash-tool.test.ts`

**Interfaces:**
- Consumes: `SpawnRunner`、`RunOptions`（Task 8）；`Tool`/`ToolContext`。
- Produces: `class BashTool extends Tool`，`name='Bash'`，`parameters_schema={command(req), description?, timeout?, run_in_background?, dangerouslyDisableSandbox?}`。返回 JSON `{command, exitCode, stdout, stderr, timedOut, background, pid?, stdoutFile?, truncated}`（错误也以对象返回，`exitCode` 非 0；仅参数错误以 `Error: ...` 返）。
- 导出 `resolveBashExe(): string`（供测试与 PowerShell 工具无关）：`process.env.CODEZ_BASH_PATH` → `GIT_BASH_PATH` → 常见 Git Bash 路径 → `where bash` → 兜底 `'bash'`。
- 工作目录会话级持久：模块内 `Map<sessionId, cwd>`，默认 `workspaceRoot`；检测命令首部 `cd <dir>` 并持久化解析后的绝对路径。

**说明：** `timeout` 默认 120000、上限 600000；`run_in_background:true` 立即返回 `{background:true, pid, stdoutFile}`。`dangerouslyDisableSandbox` 本期占位（无沙箱），不改变行为。Git Bash 不可用且回退 `bash` 也启动失败时返 `Error: bash shell is not available...`。

- [ ] **Step 1: Write the failing test**

```ts
// src/tests/bash-tool.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { BashTool, resolveBashExe } from '../main/tools/builtin/BashTool'

const BASH = resolveBashExe()
const bashOk = fs.existsSync(BASH)

let root: string
async function setup(): Promise<string> {
  root = path.join(os.tmpdir(), `codez-bash-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true })
  return root
}

describe.skipIf(!bashOk)('BashTool', () => {
  beforeEach(async () => { await setup() })
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }) })

  it('前台 echo：exitCode 0 且 stdout 含 hello', async () => {
    const tool = new BashTool()
    const result = await tool.execute(JSON.stringify({ command: 'echo hello' }), { workspaceRoot: root, sessionId: 'b1' })
    const parsed = JSON.parse(result)
    expect(parsed.exitCode).toBe(0)
    expect(parsed.stdout).toContain('hello')
    expect(parsed.background).toBe(false)
  }, 30000)

  it('timeout：timedOut true', async () => {
    const tool = new BashTool()
    const result = await tool.execute(JSON.stringify({ command: 'sleep 5', timeout: 500 }), { workspaceRoot: root, sessionId: 'b2' })
    const parsed = JSON.parse(result)
    expect(parsed.timedOut).toBe(true)
  }, 15000)

  it('background：立即返回 pid/stdoutFile', async () => {
    const tool = new BashTool()
    const result = await tool.execute(JSON.stringify({ command: 'sleep 2', run_in_background: true }), { workspaceRoot: root, sessionId: 'b3' })
    const parsed = JSON.parse(result)
    expect(parsed.background).toBe(true)
    expect(typeof parsed.pid).toBe('number')
    expect(parsed.stdoutFile).toBeTruthy()
    try { process.kill(parsed.pid) } catch {}
  }, 15000)

  it('工作目录跨调用持久：cd sub 后 pwd 为 sub', async () => {
    const tool = new BashTool()
    await tool.execute(JSON.stringify({ command: 'cd sub && pwd' }), { workspaceRoot: root, sessionId: 'b4' })
    const r2 = await tool.execute(JSON.stringify({ command: 'pwd' }), { workspaceRoot: root, sessionId: 'b4' })
    const parsed = JSON.parse(r2)
    expect(parsed.stdout.replace(/\\/g, '/')).toContain('sub')
  }, 30000)

  it('缺 command：返 Error', async () => {
    const tool = new BashTool()
    const result = await tool.execute(JSON.stringify({}), { workspaceRoot: root, sessionId: 'b5' })
    expect(result.startsWith('Error:')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/bash-tool.test.ts`
Expected: FAIL，`Cannot find module '../main/tools/builtin/BashTool'`。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/tools/builtin/BashTool.ts
import { Tool, ToolContext } from '../Tool'
import * as path from 'path'
import * as fs from 'fs'
import { execSync } from 'child_process'
import { SpawnRunner } from '../SpawnRunner'

interface BashArgs {
  command?: string
  description?: string
  timeout?: number
  run_in_background?: boolean
  dangerouslyDisableSandbox?: boolean
}

const DEFAULT_TIMEOUT = 120000
const MAX_TIMEOUT = 600000

const sessionCwd: Map<string, string> = new Map()

export function resolveBashExe(): string {
  if (process.env.CODEZ_BASH_PATH && fs.existsSync(process.env.CODEZ_BASH_PATH)) return process.env.CODEZ_BASH_PATH
  if (process.env.GIT_BASH_PATH && fs.existsSync(process.env.GIT_BASH_PATH)) return process.env.GIT_BASH_PATH
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  try {
    const which = execSync('where bash', { encoding: 'utf-8' }).split('\n').map((s) => s.trim()).filter(Boolean)
    if (which.length > 0 && fs.existsSync(which[0])) return which[0]
  } catch {}
  return 'bash'
}

/** 检测命令首部 `cd <dir>`，返回解析后的绝对路径（相对当前 cwd），无则 null。 */
function detectCd(command: string, currentCwd: string): string | null {
  const m = command.match(/^\s*cd\s+([^\s&|;]+)/)
  if (!m) return null
  const target = m[1].replace(/^["']|["']$/g, '')
  if (!target) return null
  const resolved = path.isAbsolute(target) ? target : path.resolve(currentCwd, target)
  if (fs.existsSync(resolved)) return resolved
  return null
}

export class BashTool extends Tool {
  get name() {
    return 'Bash'
  }

  get description() {
    return 'Executes a bash command and returns its output. Runs Git Bash (POSIX sh), not cmd.exe or PowerShell — use Unix shell syntax (/dev/null not NUL, forward slashes, $VAR not %VAR%); for multi-line strings use a heredoc. Working directory persists between calls. Avoid using this for find/grep/cat/head/tail/sed/awk/echo — use dedicated tools (Glob/Grep/Read). timeout in ms (default 120000, max 600000). run_in_background runs detached and keeps running across turns. Interactive flags (e.g. git rebase -i) are not supported; commit/push only when asked. To stop a background process, run `kill <pid>` in a later Bash call.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute.' },
        description: { type: 'string', description: 'Short description of what the command does.' },
        timeout: { type: 'number', description: 'Timeout in ms. Default 120000, max 600000.' },
        run_in_background: { type: 'boolean', description: 'Run detached; returns pid + stdoutFile immediately.' },
        dangerouslyDisableSandbox: { type: 'boolean', description: 'Reserved (no sandbox this period).' }
      },
      required: ['command']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as BashArgs
      if (!parsed.command) return 'Error: command is required.'

      const sessionId = context.sessionId || '_default'
      const currentCwd = sessionCwd.get(sessionId) || context.workspaceRoot
      const executable = resolveBashExe()

      let timeout = parsed.timeout ?? DEFAULT_TIMEOUT
      if (timeout > MAX_TIMEOUT) timeout = MAX_TIMEOUT

      const runner = new SpawnRunner()
      const result = await runner.run({
        command: parsed.command,
        cwd: currentCwd,
        shell: 'bash',
        executable,
        timeout,
        run_in_background: parsed.run_in_background === true
      })

      // 持久化 cd 后的工作目录（前台命令才检测；后台不切换主会话 cwd）
      if (!result.background) {
        const next = detectCd(parsed.command, currentCwd)
        if (next) sessionCwd.set(sessionId, next)
      }

      return JSON.stringify({
        command: parsed.command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        background: result.background,
        pid: result.pid,
        stdoutFile: result.stdoutFile,
        truncated: result.truncated
      }, null, 2)
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/bash-tool.test.ts`
Expected: PASS（5 例全绿；Git Bash 不可用则整组 skip）。

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/builtin/BashTool.ts src/tests/bash-tool.test.ts
git commit -m "feat(tools): add Bash tool (Git Bash + spawn fallback, bg/timeout/persistent cwd)"
```
