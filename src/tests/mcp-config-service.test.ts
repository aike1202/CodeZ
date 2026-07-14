import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { McpConfigService } from '../main/services/mcp/McpConfigService'

const roots: string[] = []

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('McpConfigService', () => {
  it('selects local over project over user and preserves shadow diagnostics', async () => {
    const userData = await temporaryRoot('codez-mcp-config-user-')
    const workspace = await temporaryRoot('codez-mcp-config-workspace-')
    const service = new McpConfigService(userData)
    await service.saveUserServers({ shared: { type: 'stdio', command: 'node', args: ['user.cjs'] } })
    await writeFile(path.join(workspace, '.mcp.json'), JSON.stringify({
      mcpServers: { shared: { type: 'stdio', command: 'node', args: ['project.cjs'] } }
    }), 'utf8')
    await mkdir(path.join(workspace, '.codez'), { recursive: true })
    await writeFile(path.join(workspace, '.codez', 'mcp.local.json'), JSON.stringify({
      mcpServers: { shared: { type: 'stdio', command: 'node', args: ['local.cjs'] } }
    }), 'utf8')

    const configs = (await service.load(workspace)).filter((item) => item.name === 'shared')
    expect(configs.map((item) => [item.scope, item.effective, item.shadowedBy])).toEqual([
      ['user', false, 'project'],
      ['project', false, 'local'],
      ['local', true, undefined]
    ])
    expect(configs.find((item) => item.effective)?.config).toMatchObject({ args: ['local.cjs'] })
  })

  it('applies a managed deny after lower-scope merging', async () => {
    const userData = await temporaryRoot('codez-mcp-managed-user-')
    const workspace = await temporaryRoot('codez-mcp-managed-workspace-')
    const managedPath = path.join(await temporaryRoot('codez-mcp-managed-policy-'), 'managed.json')
    await writeFile(managedPath, JSON.stringify({ denyServers: ['blocked'] }), 'utf8')
    const service = new McpConfigService(userData, managedPath)
    await service.saveUserServers({ blocked: { type: 'http', url: 'https://example.test/mcp' } })

    const selected = (await service.load(workspace)).find((item) => item.name === 'blocked' && item.effective)
    expect(selected).toMatchObject({ policyDisabled: true, shadowedBy: 'managed' })
    expect(selected?.config.enabled).toBe(false)
  })

  it('rejects plaintext sensitive values and insecure remote OAuth', async () => {
    const service = new McpConfigService(await temporaryRoot('codez-mcp-validation-'))
    await expect(service.saveUserServers({
      plain: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer plaintext' } }
    })).rejects.toThrow(/secure-secret expression/)
    await expect(service.saveUserServers({
      oauth: { type: 'http', url: 'http://127.0.0.1:3000/mcp', oauth: { clientId: 'test' } }
    })).rejects.toThrow(/OAuth is not allowed/)
    await expect(service.saveUserServers({
      stdio: { type: 'stdio', command: 'node', args: ['server.js', '--api-key=plaintext'] }
    })).rejects.toThrow(/secure-secret expression/)
    await expect(service.saveUserServers({
      shell: { type: 'stdio', command: 'pwsh', args: ['-Command', 'node server.js'] }
    })).rejects.toThrow(/shell command-string/)
  })

  it('updates a user server enabled flag without changing the rest of its JSON config', async () => {
    const service = new McpConfigService(await temporaryRoot('codez-mcp-toggle-user-'))
    await service.saveUserServers({
      filesystem: {
        type: 'stdio',
        description: 'Workspace files',
        command: 'node',
        args: ['server.cjs'],
        enabled: true
      }
    })

    await service.setUserServerEnabled('filesystem', false)

    const config = (await service.load()).find((item) => item.name === 'filesystem')
    expect(config?.config).toMatchObject({
      description: 'Workspace files',
      command: 'node',
      args: ['server.cjs'],
      enabled: false
    })
    await expect(service.setUserServerEnabled('missing', true)).rejects.toThrow(/user scope/)
  })

  it('validates optional server descriptions', async () => {
    const service = new McpConfigService(await temporaryRoot('codez-mcp-description-user-'))
    await expect(service.saveUserServers({
      valid: { type: 'http', url: 'https://example.test/mcp', description: 'Issue tracker tools' }
    })).resolves.toBeUndefined()
    await expect(service.saveUserServers({
      invalid: { type: 'http', url: 'https://example.test/mcp', description: 'x'.repeat(1025) }
    })).rejects.toThrow(/description/)
  })

  it('writes user configuration atomically and preserves an existing private file mode', async () => {
    const userData = await temporaryRoot('codez-mcp-atomic-user-')
    const service = new McpConfigService(userData)
    const target = path.join(userData, 'mcp.json')
    await service.saveUserServers({ first: { type: 'http', url: 'https://example.test/mcp' } })
    expect((await stat(target)).isFile()).toBe(true)
    expect((await readdir(userData)).some((name) => name.endsWith('.tmp'))).toBe(false)
    if (process.platform !== 'win32') {
      expect((await stat(target)).mode & 0o777).toBe(0o600)
      await chmod(target, 0o640)
      await service.saveUserServers({ second: { type: 'http', url: 'https://example.test/next' } })
      expect((await stat(target)).mode & 0o777).toBe(0o640)
    }
  })

  it('rejects project stdio paths that escape the canonical workspace', async () => {
    const userData = await temporaryRoot('codez-mcp-path-user-')
    const workspace = await temporaryRoot('codez-mcp-path-workspace-')
    await writeFile(path.join(workspace, '.mcp.json'), JSON.stringify({
      mcpServers: { escaped: { type: 'stdio', command: '../outside/server.exe' } }
    }), 'utf8')

    await expect(new McpConfigService(userData).load(workspace)).rejects.toThrow(/inside the workspace/)
  })

  it('rejects different effective server names that normalize to one identity', async () => {
    const service = new McpConfigService(await temporaryRoot('codez-mcp-name-user-'))
    await service.saveUserServers({
      'same.name': { type: 'http', url: 'https://one.example.test/mcp' },
      'same name': { type: 'http', url: 'https://two.example.test/mcp' }
    })
    await expect(service.load(await temporaryRoot('codez-mcp-name-workspace-'))).rejects.toThrow(/normalize to the same identity/)
  })

  it('keeps dynamic servers in memory and below managed policy precedence', async () => {
    const userData = await temporaryRoot('codez-mcp-dynamic-user-')
    const workspace = await temporaryRoot('codez-mcp-dynamic-workspace-')
    const managedPath = path.join(await temporaryRoot('codez-mcp-dynamic-managed-'), 'managed.json')
    await writeFile(managedPath, JSON.stringify({
      mcpServers: { shared: { type: 'http', url: 'https://managed.example.test/mcp' } }
    }), 'utf8')
    const service = new McpConfigService(userData, managedPath)
    service.setDynamicServer('temporary', { type: 'http', url: 'https://dynamic.example.test/mcp' })
    service.setDynamicServer('shared', { type: 'http', url: 'https://dynamic.example.test/shared' })
    const configs = await service.load(workspace)
    expect(configs.find((item) => item.name === 'temporary' && item.effective)).toMatchObject({ scope: 'dynamic' })
    expect(configs.find((item) => item.name === 'shared' && item.effective)).toMatchObject({
      scope: 'managed', config: { url: 'https://managed.example.test/mcp' }
    })
    service.clearDynamicServers()
    expect((await service.load(workspace)).some((item) => item.scope === 'dynamic')).toBe(false)
  })
})
