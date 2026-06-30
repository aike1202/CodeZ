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
