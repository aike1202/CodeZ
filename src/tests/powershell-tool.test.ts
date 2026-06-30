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

// Windows 下 detached 后台进程被 kill 后，其 cwd 句柄不会同步释放，
// 立即 rm 会偶发 EBUSY/EPERM。重试几次以消除测试清理的时序抖动。
async function rmRetry(target: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    try {
      await fsp.rm(target, { recursive: true, force: true })
      return
    } catch (err: any) {
      if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOTEMPTY') {
        await new Promise((r) => setTimeout(r, 200))
        continue
      }
      throw err
    }
  }
}

describe.skipIf(!isWindows)('PowerShellTool', () => {
  beforeEach(async () => { await setup() })
  afterEach(async () => { await rmRetry(root) })

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
