import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'

const electronState = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => electronState.userData },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { ProviderService } from '../main/services/ProviderService'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ProviderService config migration', () => {
  it('persists a conservative explicit context window for legacy zero values', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-provider-migration-'))
    roots.push(root)
    electronState.userData = root
    const filePath = path.join(root, 'providers.json')
    await writeFile(filePath, JSON.stringify({
      activeProviderId: 'p1',
      providers: [{
        id: 'p1', name: 'legacy', baseUrl: 'https://example.test', apiKeyRef: '',
        encryption: 'none', enabled: true, createdAt: 'now', updatedAt: 'now',
        models: [{ id: 'm1', name: 'legacy-model', maxContextTokens: 0 }],
        thinking: { enabled: true, mode: 'auto' }
      }]
    }))

    const service = new ProviderService()
    await service.load()

    expect(service.getAll()[0].models[0].maxContextTokens).toBe(8192)
    const persisted = JSON.parse(await readFile(filePath, 'utf8'))
    expect(persisted.providers[0].models[0].maxContextTokens).toBe(8192)
  })
})
