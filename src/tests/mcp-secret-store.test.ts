import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from([...value].reverse().join(''), 'utf8'),
    decryptString: (value: Buffer) => [...value.toString('utf8')].reverse().join('')
  }
}))

import { McpSecretStore } from '../main/services/mcp/McpSecretStore'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('McpSecretStore', () => {
  it('persists encrypted values and exposes only keys through listing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-mcp-secret-store-'))
    roots.push(root)
    const file = path.join(root, 'secrets.secure')
    const store = new McpSecretStore(file)
    await store.set('github.token', 'plain-secret-value')
    expect(await store.listKeys()).toEqual(['github.token'])
    expect(await store.resolve('github.token')).toBe('plain-secret-value')
    expect(await readFile(file, 'utf8')).not.toContain('plain-secret-value')
    await store.delete('github.token')
    expect(await store.listKeys()).toEqual([])
  })

  it('rejects invalid keys before touching secure storage', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-mcp-secret-key-'))
    roots.push(root)
    const store = new McpSecretStore(path.join(root, 'secrets.secure'))
    await expect(store.set('../escape', 'value')).rejects.toThrow(/secret keys/)
  })

  it('serializes concurrent writes across store instances that share one file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-mcp-secrets-concurrent-'))
    roots.push(root)
    const filePath = path.join(root, 'secrets.secure')
    const first = new McpSecretStore(filePath)
    const second = new McpSecretStore(filePath)
    await Promise.all([
      first.set('first', 'value-a'),
      second.set('second', 'value-b')
    ])
    expect(await first.listKeys()).toEqual(['first', 'second'])
    expect(await second.resolve('first')).toBe('value-a')
    expect(await first.resolve('second')).toBe('value-b')
  })
})
