### Task 10: PowerShell 工具（powershell.exe -NoProfile -NonInteractive；与 Bash 共用 SpawnRunner）

**Files:**
- Create: `src/main/tools/builtin/PowerShellTool.ts`
- Test: `src/tests/powershell-tool.test.ts`

**Interfaces:**
- Consumes: `SpawnRunner`、`RunOptions`（Task 8）；`Tool`/`ToolContext`。
- Produces: `class PowerShellTool extends Tool`，`name='PowerShell'`，`parameters_schema={command(req), description?, timeout?, run_in_background?, dangerouslyDisableSandbox?}`。返回 JSON 同 Bash（`{command, exitCode, stdout, stderr, timedOut, background, pid?, stdoutFile?, truncated}`）。
- 导出 `resolvePwshExe(): string`：`process.env.CODEZ_PS_PATH` → 兜底 `'powershell.exe'`。
- 工作目录会话级持久：模块内 `Map<sessionId, cwd>`，默认 `workspaceRoot`（与 Bash 各自独立）。
- 5.1 限制写入 description（无 `&&`/`||`、无三元/`??`/`?.`、原生 exe 不用 `2>&1`、默认 UTF-16、`-Encoding utf8`、`-NonInteractive` 禁交互命令）。

**说明：** 与 Bash 共用 `SpawnRunner`（`shell:'powershell'`），只换解释器与换行/转义策略；background 复用同一 `BackgroundTaskRegistry`。`timeout` 默认 120000、上限 600000。

- [ ] **Step 1: Write the failing test**

```ts
// src/tests/powershell-tool.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fsp from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { PowerShellTool } from '../main/tools/builtin/PowerShellTool'

const isWindows = process.platform === 'win32'

let root: string
async function setup(): Promise<string> {
  root = path.join(os.tmpdir(), `codez-ps-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true })
  return root
}

describe.skipIf(!isWindows)('PowerShellTool', () => {
  beforeEach(async () => { await setup() })
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }) })

  it('Write-Output：exitCode 0 且 stdout 含 hi', async () => {
    const tool = new PowerShellTool()
    const result = await tool.execute(JSON.stringify({ command: 'Write-Output hi' }), { workspaceRoot: root, sessionId: 'p1' })
    const parsed = JSON.parse(result)
    expect(parsed.exitCode).toBe(0)
    expect(parsed.stdout).toContain('hi')
  }, 30000)

  it('timeout：timedOut true', async () => {
    const tool = new PowerShellTool()
    const result = await tool.execute(JSON.stringify({ command: 'Start-Sleep -Seconds 5', timeout: 500 }), { workspaceRoot: root, sessionId: 'p2' })
    const parsed = JSON.parse(result)
    expect(parsed.timedOut).toBe(true)
  }, 15000)

  it('background：立即返回 pid/stdoutFile', async () => {
    const tool = new PowerShellTool()
    const result = await tool.execute(JSON.stringify({ command: 'Start-Sleep -Seconds 2', run_in_background: true }), { workspaceRoot: root, sessionId: 'p3' })
    const parsed = JSON.parse(result)
    expect(parsed.background).toBe(true)
    expect(typeof parsed.pid).toBe('number')
    try { process.kill(parsed.pid) } catch {}
  }, 15000)

  it('工作目录跨调用持久：cd sub 后 Get-Location 含 sub', async () => {
    const tool = new PowerShellTool()
    await tool.execute(JSON.stringify({ command: 'cd sub; Get-Location' }), { workspaceRoot: root, sessionId: 'p4' })
    const r2 = await tool.execute(JSON.stringify({ command: 'Get-Location' }), { workspaceRoot: root, sessionId: 'p4' })
    const parsed = JSON.parse(r2)
    expect(parsed.stdout.replace(/\\/g, '/')).toContain('sub')
  }, 30000)

  it('缺 command：返 Error', async () => {
    const tool = new PowerShellTool()
    const result = await tool.execute(JSON.stringify({}), { workspaceRoot: root, sessionId: 'p5' })
    expect(result.startsWith('Error:')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/powershell-tool.test.ts`
Expected: FAIL，`Cannot find module '../main/tools/builtin/PowerShellTool'`。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/tools/builtin/PowerShellTool.ts
import { Tool, ToolContext } from '../Tool'
import * as path from 'path'
import * as fs from 'fs'
import { SpawnRunner } from '../SpawnRunner'

interface PSArgs {
  command?: string
  description?: string
  timeout?: number
  run_in_background?: boolean
  dangerouslyDisableSandbox?: boolean
}

const DEFAULT_TIMEOUT = 120000
const MAX_TIMEOUT = 600000

const sessionCwd: Map<string, string> = new Map()

export function resolvePwshExe(): string {
  if (process.env.CODEZ_PS_PATH && fs.existsSync(process.env.CODEZ_PS_PATH)) return process.env.CODEZ_PS_PATH
  return 'powershell.exe'
}

function detectCd(command: string, currentCwd: string): string | null {
  const m = command.match(/^\s*(?:cd|Set-Location)\s+([^\s;&|]+)/)
  if (!m) return null
  const target = m[1].replace(/^["']|["']$/g, '')
  if (!target) return null
  const resolved = path.isAbsolute(target) ? target : path.resolve(currentCwd, target)
  if (fs.existsSync(resolved)) return resolved
  return null
}

export class PowerShellTool extends Tool {
  get name() {
    return 'PowerShell'
  }

  get description() {
    return 'Executes a PowerShell command with optional timeout. Working directory persists between calls; shell state does not. Edition: Windows PowerShell 5.1 (powershell.exe). Pipeline chain && and || are NOT available — use "A; if ($?) { B }". Ternary ?:, null-coalescing ??, and null-conditional ?. are NOT available. Avoid 2>&1 on native exes (wraps stderr in ErrorRecord). Default file encoding is UTF-16 LE; pass -Encoding utf8 to Out-File/Set-Content. Use Glob/Grep/Read/Edit/Write instead of Get-ChildItem -Recurse / Select-String / Get-Content / Set-Content. Interactive/blocking commands (Read-Host, git rebase -i) are forbidden (runs with -NonInteractive). timeout in ms (default 120000, max 600000); run_in_background runs detached. To stop a background process, run Stop-Process -Id <pid> in a later PowerShell call.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The PowerShell command to execute.' },
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
      const parsed = JSON.parse(args) as PSArgs
      if (!parsed.command) return 'Error: command is required.'

      const sessionId = context.sessionId || '_default'
      const currentCwd = sessionCwd.get(sessionId) || context.workspaceRoot
      const executable = resolvePwshExe()

      let timeout = parsed.timeout ?? DEFAULT_TIMEOUT
      if (timeout > MAX_TIMEOUT) timeout = MAX_TIMEOUT

      const runner = new SpawnRunner()
      const result = await runner.run({
        command: parsed.command,
        cwd: currentCwd,
        shell: 'powershell',
        executable,
        timeout,
        run_in_background: parsed.run_in_background === true
      })

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

Run: `npx vitest run src/tests/powershell-tool.test.ts`
Expected: PASS（5 例全绿；非 Windows 则整组 skip）。

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/builtin/PowerShellTool.ts src/tests/powershell-tool.test.ts
git commit -m "feat(tools): add PowerShell tool (5.1 via SpawnRunner, bg/timeout/persistent cwd)"
```
