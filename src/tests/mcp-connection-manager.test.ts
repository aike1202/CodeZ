import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { McpConfigService } from '../main/services/mcp/McpConfigService'
import { McpConnectionManager } from '../main/services/mcp/McpConnectionManager'
import { ToolManager } from '../main/tools/ToolManager'

const roots: string[] = []
const managers: McpConnectionManager[] = []
const originalTestSecret = process.env.CODEZ_MCP_TEST_TOKEN
afterEach(async () => {
  if (originalTestSecret === undefined) delete process.env.CODEZ_MCP_TEST_TOKEN
  else process.env.CODEZ_MCP_TEST_TOKEN = originalTestSecret
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('McpConnectionManager', () => {
  it('connects a real stdio server and exposes tools, resources, and prompts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-mcp-'))
    roots.push(root)
    const config = new McpConfigService(root)
    const fixture = path.resolve(__dirname, 'fixtures', 'mcp-stdio-server.cjs')
    process.env.CODEZ_MCP_TEST_TOKEN = 'stdio-secret-value'
    await config.saveUserServers({
      test: {
        type: 'stdio', command: process.execPath, args: [fixture],
        env: { CODEZ_MCP_TEST_TOKEN: '${env:CODEZ_MCP_TEST_TOKEN}' }
      }
    })
    const toolManager = new ToolManager()
    const manager = new McpConnectionManager(config, toolManager)
    managers.push(manager)
    await manager.syncWorkspace(root)

    expect(manager.getStatuses()[0]).toMatchObject({
      name: 'test', state: 'connected', toolCount: 4, resourceCount: 2, promptCount: 1
    })
    const handler = toolManager.getRegistry().resolve('mcp__test__echo')
    expect(handler?.descriptor.availability.exposure).toBe('deferred')
    const catalog = toolManager.createCatalogSnapshot()
    const initialExposure = toolManager.createExposurePlan({ catalog })
    expect(initialExposure.eagerTools.some((tool) => tool.name === 'mcp__test__echo')).toBe(false)
    const activated = new Set<string>()
    await toolManager.getRegistry().resolve('ToolSearch')!.execute(
      { query: 'select:mcp__test__echo' },
      {
        workspaceRoot: root,
        toolExposure: {
          deferredTools: initialExposure.deferredTools,
          activate: (names) => names.forEach((name) => activated.add(name))
        }
      }
    )
    expect(initialExposure.eagerTools.some((tool) => tool.name === 'mcp__test__echo')).toBe(false)
    expect(toolManager.createExposurePlan({ catalog, activatedDeferredTools: activated }).eagerTools)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'mcp__test__echo' })]))
    const result = await handler!.execute({ message: 'hello' }, {
      workspaceRoot: root, sessionId: 'session-1'
    })
    expect(result.status).toBe('success')
    expect(result.status === 'success' && result.modelContent).toContain('echo:hello')
    expect(manager.listResources()).toEqual(expect.arrayContaining([
      expect.objectContaining({ server: 'test', uri: 'test://example' })
    ]))
    expect(await manager.readResource('test', 'test://example', { workspaceRoot: root, sessionId: 'session-1' })).toMatchObject({
      contents: [expect.objectContaining({ text: 'resource-content' })]
    })
    expect(manager.listResources()).toEqual(expect.arrayContaining([
      expect.objectContaining({ server: 'test', uri: 'test://items/{id}', template: true })
    ]))
    expect(await manager.readResource('test', 'test://items/42', { workspaceRoot: root, sessionId: 'session-1' })).toMatchObject({
      contents: [expect.objectContaining({ text: 'item:42' })]
    })
    expect(manager.listPrompts()[0]).toMatchObject({ server: 'test', name: 'review' })
    expect(await manager.getPrompt('test', 'review', { subject: 'runtime' })).toMatchObject({
      messages: [expect.objectContaining({ role: 'user' })]
    })
    await expect(manager.readResource('test', 'file:///etc/passwd', { workspaceRoot: root, sessionId: 'session-1' }))
      .rejects.toThrow(/not advertised/)
    await expect(manager.getPrompt('test', 'not-advertised')).rejects.toThrow(/not advertised/)

    await toolManager.getRegistry().resolve('mcp__test__log_secret')!.execute({}, {
      workspaceRoot: root, sessionId: 'session-1'
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    const serializedLogs = JSON.stringify(manager.getStatuses()[0].logs)
    expect(serializedLogs).toContain('[REDACTED]')
    expect(serializedLogs).not.toContain('stdio-secret-value')

    await toolManager.getRegistry().resolve('mcp__test__flood_logs')!.execute({}, {
      workspaceRoot: root, sessionId: 'session-1'
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(manager.getStatuses()[0].logs.length).toBeLessThanOrEqual(200)

    const pidResult = await toolManager.getRegistry().resolve('mcp__test__pid')!.execute({}, {
      workspaceRoot: root, sessionId: 'session-1'
    })
    const pid = Number(pidResult.status === 'success' && /pid:(\d+)/.exec(pidResult.modelContent)?.[1])
    expect(pid).toBeGreaterThan(0)
    await manager.stopAll()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(() => process.kill(pid, 0)).toThrow()
  }, 15_000)

  it('bounds stderr from an abnormal stdio server exit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-mcp-stderr-'))
    roots.push(root)
    const config = new McpConfigService(root)
    await config.saveUserServers({
      failed: {
        type: 'stdio', command: process.execPath,
        args: [path.resolve(__dirname, 'fixtures', 'mcp-stdio-failure.cjs')],
        reconnect: { enabled: false, maxAttempts: 0, baseDelayMs: 100, maxDelayMs: 100 }
      }
    })
    const manager = new McpConnectionManager(config, new ToolManager())
    managers.push(manager)
    await manager.syncWorkspace(root)
    const status = manager.getStatuses()[0]
    expect(status.state).toBe('failed')
    expect(status.logs.length).toBeLessThanOrEqual(200)
    expect(status.logs.every((entry) => entry.message.length <= 8192)).toBe(true)
  }, 15_000)

  it('enforces a configurable handshake timeout and closes the hanging process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-mcp-timeout-'))
    roots.push(root)
    const config = new McpConfigService(root)
    await config.saveUserServers({
      hanging: {
        type: 'stdio', command: process.execPath,
        args: [path.resolve(__dirname, 'fixtures', 'mcp-stdio-hang.cjs')],
        handshakeTimeoutMs: 100,
        reconnect: { enabled: false, maxAttempts: 0, baseDelayMs: 100, maxDelayMs: 100 }
      }
    })
    const manager = new McpConnectionManager(config, new ToolManager())
    managers.push(manager)
    await manager.syncWorkspace(root)
    expect(manager.getStatuses()[0]).toMatchObject({
      state: 'failed', error: { code: 'MCP_HANDSHAKE_TIMEOUT' }
    })
  }, 5000)
})
