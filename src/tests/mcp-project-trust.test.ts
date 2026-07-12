import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import { McpConfigService } from '../main/services/mcp/McpConfigService'
import { McpConnectionManager } from '../main/services/mcp/McpConnectionManager'
import { ToolManager } from '../main/tools/ToolManager'

const roots: string[] = []
const managers: McpConnectionManager[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('MCP project config trust', () => {
  it('requires a matching fingerprint and invalidates trust after config changes', async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'codez-mcp-trust-user-'))
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'codez-mcp-trust-workspace-'))
    roots.push(userData, workspace)
    const service = new McpConfigService(userData)
    await writeFile(path.join(workspace, '.mcp.json'), JSON.stringify({
      servers: { local: { type: 'stdio', command: 'node', args: ['server.js'] } }
    }), 'utf8')

    const [first] = await service.load(workspace)
    expect(first).toMatchObject({ scope: 'project', trusted: false })
    await service.trustProjectFingerprint(first.fingerprint)
    expect((await service.load(workspace))[0].trusted).toBe(true)

    await writeFile(path.join(workspace, '.mcp.json'), JSON.stringify({
      servers: { local: { type: 'stdio', command: 'node', args: ['changed.js'] } }
    }), 'utf8')
    const [changed] = await service.load(workspace)
    expect(changed.fingerprint).not.toBe(first.fingerprint)
    expect(changed.trusted).toBe(false)
  })

  it('does not spawn, connect, or expand project secrets before fingerprint approval', async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'codez-mcp-trust-gate-user-'))
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'codez-mcp-trust-gate-workspace-'))
    roots.push(userData, workspace)
    const fixture = path.resolve(__dirname, 'fixtures', 'mcp-stdio-server.cjs')
    await writeFile(path.join(workspace, '.mcp.json'), JSON.stringify({
      servers: {
        project: {
          type: 'stdio', command: 'node', args: [fixture],
          env: { CODEZ_MCP_TEST_TOKEN: '${secret:project.token}' },
          reconnect: { enabled: false, maxAttempts: 0, baseDelayMs: 100, maxDelayMs: 100 }
        }
      }
    }), 'utf8')
    const config = new McpConfigService(userData)
    const resolve = vi.fn(async () => 'project-secret')
    const tools = new ToolManager()
    const manager = new McpConnectionManager(config, tools, { resolve })
    managers.push(manager)

    await manager.syncWorkspace(workspace)
    const [untrusted] = await manager.getConfiguration()
    expect(manager.getStatuses()[0]).toMatchObject({ state: 'trust-required' })
    expect(resolve).not.toHaveBeenCalled()
    expect(tools.getRegistry().resolve('mcp__project__echo')).toBeUndefined()

    await manager.trustProject(untrusted.fingerprint)
    expect(manager.getStatuses()[0]).toMatchObject({ state: 'connected' })
    expect(resolve).toHaveBeenCalledWith('project.token')
    expect(tools.getRegistry().resolve('mcp__project__echo')).toBeDefined()
  }, 15_000)
})
