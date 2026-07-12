import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { app, safeStorage } from 'electron'
import { atomicWriteSecureFile } from '../context/atomicFile'

export interface McpSecretResolver {
  resolve(key: string): Promise<string | undefined>
}

function defaultSecretPath(): string {
  try {
    if (app?.getPath) return path.join(app.getPath('userData'), 'mcp-secrets.secure')
  } catch {}
  return path.join(os.tmpdir(), 'codez-userdata', 'mcp-secrets.secure')
}

function validateKey(key: string): void {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key)) {
    throw new Error('MCP secret keys may contain only letters, numbers, dot, underscore, and hyphen.')
  }
}

export class McpSecretStore implements McpSecretResolver {
  private static readonly writeQueues = new Map<string, Promise<void>>()
  constructor(private readonly filePath = defaultSecretPath()) {}

  private encryptionAvailable(): boolean {
    try { return Boolean(safeStorage?.isEncryptionAvailable?.()) } catch { return false }
  }

  private requireEncryption(): void {
    if (!this.encryptionAvailable()) {
      throw new Error('Secure operating-system storage is unavailable; MCP secrets cannot be persisted.')
    }
  }

  private async readAllUnsafe(): Promise<Record<string, string>> {
    this.requireEncryption()
    try {
      const encrypted = Buffer.from(await fs.readFile(this.filePath, 'utf8'), 'base64')
      const parsed = JSON.parse(safeStorage.decryptString(encrypted))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, string>
        : {}
    } catch (error: any) {
      if (error?.code === 'ENOENT') return {}
      throw new Error('MCP secure secret storage could not be read.')
    }
  }

  private async readAll(): Promise<Record<string, string>> {
    await McpSecretStore.writeQueues.get(path.resolve(this.filePath))?.catch(() => undefined)
    return this.readAllUnsafe()
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const key = path.resolve(this.filePath)
    const previous = McpSecretStore.writeQueues.get(key) || Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    McpSecretStore.writeQueues.set(key, current)
    return current.finally(() => {
      if (McpSecretStore.writeQueues.get(key) === current) McpSecretStore.writeQueues.delete(key)
    })
  }

  async resolve(key: string): Promise<string | undefined> {
    validateKey(key)
    return (await this.readAll())[key]
  }

  async listKeys(): Promise<string[]> {
    return Object.keys(await this.readAll()).sort()
  }

  async set(key: string, value: string): Promise<void> {
    validateKey(key)
    if (!value) throw new Error('MCP secret values cannot be empty.')
    await this.enqueueWrite(async () => {
      const values = await this.readAllUnsafe()
      values[key] = value
      const encrypted = safeStorage.encryptString(JSON.stringify(values)).toString('base64')
      await atomicWriteSecureFile(this.filePath, encrypted)
    })
  }

  async delete(key: string): Promise<void> {
    validateKey(key)
    await this.enqueueWrite(async () => {
      const values = await this.readAllUnsafe()
      delete values[key]
      const encrypted = safeStorage.encryptString(JSON.stringify(values)).toString('base64')
      await atomicWriteSecureFile(this.filePath, encrypted)
    })
  }
}

const EXPRESSION = /\$\{(env|secret):([^}]+)\}/g

export async function resolveMcpSecretExpressions(
  value: string,
  secrets: McpSecretResolver,
  onResolved?: (value: string) => void
): Promise<string> {
  const matches = [...value.matchAll(EXPRESSION)]
  let resolved = value
  for (const match of matches) {
    const [expression, source, key] = match
    let replacement: string | undefined
    if (source === 'env') {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid MCP environment variable expression.')
      replacement = process.env[key]
      if (replacement === undefined) throw new Error(`MCP environment variable '${key}' is not defined.`)
    } else {
      replacement = await secrets.resolve(key)
      if (replacement === undefined) throw new Error(`MCP secret '${key}' is not configured.`)
    }
    onResolved?.(replacement)
    resolved = resolved.replace(expression, replacement)
  }
  if (resolved.includes('${')) throw new Error('Invalid MCP secret expression.')
  return resolved
}
