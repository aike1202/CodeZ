### Task 8: SpawnRunner + BackgroundTaskRegistry（Bash/PowerShell 共用）

**Files:**
- Create: `src/main/tools/SpawnRunner.ts`
- Test: `src/tests/spawn-runner.test.ts`

**Interfaces:**
- Consumes: `child_process.spawn`、`os.tmpdir()`。
- Produces（`src/main/tools/SpawnRunner.ts`）：
  - `interface SpawnResult { exitCode: number|null; stdout: string; stderr: string; timedOut: boolean; background: boolean; pid?: number; stdoutFile?: string; stderrFile?: string; truncated: boolean }`
  - `interface RunOptions { command: string; cwd: string; shell: 'bash'|'powershell'; timeout?: number; run_in_background?: boolean; executable?: string; env?: NodeJS.ProcessEnv }`
  - `class SpawnRunner` with `run(opts): Promise<SpawnResult>`；导出 `truncateOutput(text, head=1000, tail=3000): { text:string; truncated:boolean }`。
  - `class BackgroundTaskRegistry`：`add(entry): string`、`get(taskId)`、`list()`、`remove(taskId)`；单例 `getBackgroundTaskRegistry()`。
  - `BackgroundTaskEntry { pid:number; stdoutFile:string; stderrFile:string; startedAt:number; shellType:'bash'|'powershell' }`
- 后续依赖：Task 9（Bash）/Task 10（PowerShell）通过 `new SpawnRunner().run({...})` 调用，background 任务经 `getBackgroundTaskRegistry()` 登记。

**说明：** 前台：spawn 收集 stdout/stderr，`timeout` 到则 kill 置 `timedOut`，输出 `truncateOutput`（head 1000 + tail 3000 + System Note）。后台：detached spawn，stdout/stderr 重定向到 tmp 文件，立即返回 `{background:true, pid, stdoutFile, stderrFile}`，并登记到 `BackgroundTaskRegistry`。`truncateOutput` 阈值 4000 字符（与现 `run_command` 一致）。

- [ ] **Step 1: Write the failing test**

```ts
// src/tests/spawn-runner.test.ts
import { describe, it, expect } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import { SpawnRunner, truncateOutput, getBackgroundTaskRegistry } from '../main/tools/SpawnRunner'

const SHELL = process.platform === 'win32' ? 'powershell' : 'bash'
const EXEC = process.platform === 'win32' ? 'powershell.exe' : 'bash'
function echoCmd(): string {
  return SHELL === 'powershell' ? 'Write-Output hello' : 'echo hello'
}
function sleepCmd(): string {
  return SHELL === 'powershell' ? 'Start-Sleep -Seconds 3' : 'sleep 3'
}

describe('truncateOutput', () => {
  it('短文本不截断', () => {
    const r = truncateOutput('short')
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('short')
  })
  it('长文本保留 head+tail 并标注', () => {
    const big = 'A'.repeat(5000)
    const r = truncateOutput(big)
    expect(r.truncated).toBe(true)
    expect(r.text).toContain('[System Note:')
    expect(r.text.length).toBeLessThan(big.length)
    expect(r.text.startsWith('A')).toBe(true)
    expect(r.text.endsWith('A')).toBe(true)
  })
})

describe('SpawnRunner', () => {
  const cwd = process.cwd()

  it('前台执行：返回 exitCode 0 与 stdout', async () => {
    const runner = new SpawnRunner()
    const result = await runner.run({ command: echoCmd(), cwd, shell: SHELL, executable: EXEC, timeout: 15000 })
    expect(result.background).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello')
  }, 30000)

  it('timeout：返回 timedOut true', async () => {
    const runner = new SpawnRunner()
    const result = await runner.run({ command: sleepCmd(), cwd, shell: SHELL, executable: EXEC, timeout: 500 })
    expect(result.timedOut).toBe(true)
  }, 15000)

  it('background：立即返回 pid/stdoutFile 并登记注册表', async () => {
    const registry = getBackgroundTaskRegistry()
    const before = registry.list().length
    const runner = new SpawnRunner()
    const result = await runner.run({ command: sleepCmd(), cwd, shell: SHELL, executable: EXEC, run_in_background: true })
    expect(result.background).toBe(true)
    expect(typeof result.pid).toBe('number')
    expect(result.stdoutFile).toBeTruthy()
    expect(fs.existsSync(result.stdoutFile!)).toBe(true)
    expect(registry.list().length).toBeGreaterThan(before)
    // 清理：杀掉后台进程
    try { process.kill(result.pid!) } catch {}
  }, 15000)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/spawn-runner.test.ts`
Expected: FAIL，`Cannot find module '../main/tools/SpawnRunner'`。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/tools/SpawnRunner.ts
import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface SpawnResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  background: boolean
  pid?: number
  stdoutFile?: string
  stderrFile?: string
  truncated: boolean
}

export interface RunOptions {
  command: string
  cwd: string
  shell: 'bash' | 'powershell'
  timeout?: number
  run_in_background?: boolean
  executable?: string
  env?: NodeJS.ProcessEnv
}

export interface BackgroundTaskEntry {
  pid: number
  stdoutFile: string
  stderrFile: string
  startedAt: number
  shellType: 'bash' | 'powershell'
}

export function truncateOutput(text: string, head = 1000, tail = 3000): { text: string; truncated: boolean } {
  if (!text) return { text: '', truncated: false }
  const maxLen = head + tail
  if (text.length <= maxLen) return { text, truncated: false }
  return {
    text: `${text.slice(0, head)}\n\n[System Note: Output truncated (Original size: ${text.length} chars). Head ${head} + tail ${tail} kept. Do NOT rerun the same command; redirect to a file and Read it, or filter with Grep.]\n\n${text.slice(-tail)}`,
    truncated: true
  }
}

export class BackgroundTaskRegistry {
  private tasks: Map<string, BackgroundTaskEntry> = new Map()
  private counter = 0

  add(entry: BackgroundTaskEntry): string {
    const id = `bg-${Date.now()}-${this.counter++}`
    this.tasks.set(id, entry)
    return id
  }
  get(taskId: string): BackgroundTaskEntry | undefined {
    return this.tasks.get(taskId)
  }
  list(): BackgroundTaskEntry[] {
    return Array.from(this.tasks.values())
  }
  remove(taskId: string): void {
    this.tasks.delete(taskId)
  }
}

let registryInstance: BackgroundTaskRegistry | null = null
export function getBackgroundTaskRegistry(): BackgroundTaskRegistry {
  if (!registryInstance) registryInstance = new BackgroundTaskRegistry()
  return registryInstance
}

export class SpawnRunner {
  run(opts: RunOptions): Promise<SpawnResult> {
    return opts.run_in_background ? this.runBackground(opts) : this.runForeground(opts)
  }

  private buildArgs(opts: RunOptions): { exe: string; args: string[] } {
    if (opts.shell === 'powershell') {
      return { exe: opts.executable || 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', opts.command] }
    }
    return { exe: opts.executable || 'bash', args: ['-c', opts.command] }
  }

  private runForeground(opts: RunOptions): Promise<SpawnResult> {
    return new Promise((resolve) => {
      const { exe, args } = this.buildArgs(opts)
      const proc = spawn(exe, args, { cwd: opts.cwd, env: opts.env || process.env, windowsHide: true })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let timer: NodeJS.Timeout | null = null

      proc.stdout?.on('data', (d) => { stdout += d.toString() })
      proc.stderr?.on('data', (d) => { stderr += d.toString() })

      const finish = (exitCode: number | null) => {
        if (timer) clearTimeout(timer)
        const out = truncateOutput(stdout)
        const err = truncateOutput(stderr)
        resolve({
          exitCode,
          stdout: out.text,
          stderr: err.text,
          timedOut,
          background: false,
          pid: proc.pid,
          truncated: out.truncated || err.truncated
        })
      }

      if (opts.timeout && opts.timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true
          try { proc.kill('SIGKILL') } catch {}
        }, opts.timeout)
      }

      proc.on('error', () => finish(1))
      proc.on('close', (code) => finish(code))
    })
  }

  private runBackground(opts: RunOptions): Promise<SpawnResult> {
    const { exe, args } = this.buildArgs(opts)
    const stdoutFile = path.join(os.tmpdir(), `codez-bg-${Date.now()}-${Math.random().toString(36).slice(2)}.out`)
    const stderrFile = path.join(os.tmpdir(), `codez-bg-${Date.now()}-${Math.random().toString(36).slice(2)}.err`)
    const outFd = fs.openSync(stdoutFile, 'w')
    const errFd = fs.openSync(stderrFile, 'w')

    const proc = spawn(exe, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      detached: true,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true
    })
    fs.closeSync(outFd)
    fs.closeSync(errFd)

    const pid = proc.pid
    getBackgroundTaskRegistry().add({ pid, stdoutFile, stderrFile, startedAt: Date.now(), shellType: opts.shell })
    try { proc.unref() } catch {}

    return Promise.resolve({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      background: true,
      pid,
      stdoutFile,
      stderrFile,
      truncated: false
    })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/spawn-runner.test.ts`
Expected: PASS（5 例全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/SpawnRunner.ts src/tests/spawn-runner.test.ts
git commit -m "feat(tools): add SpawnRunner + BackgroundTaskRegistry for Bash/PowerShell"
```
