import { randomBytes } from 'crypto'
import * as fs from 'fs/promises'
import * as http from 'http'
import * as path from 'path'
import * as os from 'os'
import { app, safeStorage, shell } from 'electron'
import { discoverOAuthServerInfo, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { McpRemoteServerConfig } from './types'
import { atomicWriteSecureFile } from '../context/atomicFile'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

interface CredentialRecord {
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  discoveryState?: OAuthDiscoveryState
}

function defaultCredentialPath(): string {
  try {
    if (app?.getPath) return path.join(app.getPath('userData'), 'mcp-oauth.secure')
  } catch {}
  return path.join(os.tmpdir(), 'codez-userdata', 'mcp-oauth.secure')
}

class McpCredentialStore {
  private memory = new Map<string, CredentialRecord>()
  private writeQueue: Promise<void> = Promise.resolve()
  constructor(private readonly filePath = defaultCredentialPath()) {}

  private encryptionAvailable(): boolean {
    try { return Boolean(safeStorage?.isEncryptionAvailable?.()) } catch { return false }
  }

  private async readAll(): Promise<Record<string, CredentialRecord>> {
    if (!this.encryptionAvailable()) return Object.fromEntries(this.memory)
    try {
      const encrypted = Buffer.from(await fs.readFile(this.filePath, 'utf8'), 'base64')
      return JSON.parse(safeStorage.decryptString(encrypted))
    } catch { return {} }
  }

  async get(key: string): Promise<CredentialRecord> {
    await this.writeQueue.catch(() => undefined)
    return (await this.readAll())[key] || {}
  }

  async set(key: string, value: CredentialRecord): Promise<void> {
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      if (!this.encryptionAvailable()) {
        if (value.tokens) throw new Error('Secure operating-system storage is unavailable; MCP OAuth tokens cannot be stored.')
        this.memory.set(key, value)
        return
      }
      const all = await this.readAll()
      all[key] = value
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      await atomicWriteSecureFile(this.filePath, safeStorage.encryptString(JSON.stringify(all)).toString('base64'))
    })
    this.writeQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  async delete(key: string): Promise<void> {
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      this.memory.delete(key)
      if (!this.encryptionAvailable()) return
      const all = await this.readAll()
      delete all[key]
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      await atomicWriteSecureFile(this.filePath, safeStorage.encryptString(JSON.stringify(all)).toString('base64'))
    })
    this.writeQueue = operation.then(() => undefined, () => undefined)
    return operation
  }
}

const credentialStore = new McpCredentialStore()

export class McpOAuthProvider implements OAuthClientProvider {
  private verifier = ''
  private expectedState = randomBytes(24).toString('base64url')
  private callbackServer?: http.Server
  private callbackPort?: number
  private callbackPromise?: Promise<string>
  private resolveCallback?: (code: string) => void
  private rejectCallback?: (error: Error) => void
  private interactive = false
  private pendingAuthorizationUrl?: URL
  private stateConsumed = false

  constructor(
    private readonly key: string,
    private readonly serverName: string,
    private readonly config: McpRemoteServerConfig,
    private readonly openExternal: (url: string) => Promise<unknown> = (url) => shell.openExternal(url)
  ) {}

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.callbackPort || this.config.oauth?.callbackPort || 0}/oauth/callback`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `CodeZ (${this.serverName})`,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
  }

  state(): string {
    if (this.stateConsumed) {
      this.expectedState = randomBytes(24).toString('base64url')
      this.stateConsumed = false
    }
    return this.expectedState
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.config.oauth?.clientId) return { client_id: this.config.oauth.clientId }
    return (await credentialStore.get(this.key)).clientInformation
  }

  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> {
    await credentialStore.set(this.key, { ...(await credentialStore.get(this.key)), clientInformation: value })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await credentialStore.get(this.key)).tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await credentialStore.set(this.key, { ...(await credentialStore.get(this.key)), tokens })
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> { this.verifier = codeVerifier }
  async codeVerifier(): Promise<string> { return this.verifier }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await credentialStore.set(this.key, {
      ...(await credentialStore.get(this.key)),
      discoveryState: {
        authorizationServerUrl: discoveryState.authorizationServerUrl,
        resourceMetadataUrl: discoveryState.resourceMetadataUrl
      }
    })
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await credentialStore.get(this.key)).discoveryState
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all') return credentialStore.delete(this.key)
    if (scope === 'verifier') { this.verifier = ''; return }
    const current = await credentialStore.get(this.key)
    if (scope === 'client') delete current.clientInformation
    if (scope === 'tokens') delete current.tokens
    if (scope === 'discovery') delete current.discoveryState
    await credentialStore.set(this.key, current)
  }

  async prepareCallback(): Promise<void> {
    if (this.callbackServer) return
    const configuredPort = this.config.oauth?.callbackPort || 0
    this.callbackPromise = new Promise<string>((resolve, reject) => {
      this.resolveCallback = resolve
      this.rejectCallback = reject
    })
    this.callbackServer = http.createServer((request, response) => {
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      const remote = request.socket.remoteAddress
      const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      if (request.method !== 'GET' || !loopback || url.pathname !== '/oauth/callback') { response.writeHead(404).end(); return }
      const error = url.searchParams.get('error')
      const state = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      if (error || this.stateConsumed || state !== this.expectedState || !code) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('OAuth authorization failed. Return to CodeZ.')
        this.rejectCallback?.(new Error(error || 'OAuth callback state/code validation failed.'))
      } else {
        this.stateConsumed = true
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Authorization completed. You can return to CodeZ.')
        this.resolveCallback?.(code)
      }
      void this.closeCallbackServer()
    })
    await new Promise<void>((resolve, reject) => {
      this.callbackServer!.once('error', reject)
      this.callbackServer!.listen(configuredPort, '127.0.0.1', () => resolve())
    })
    const address = this.callbackServer.address()
    if (address && typeof address === 'object') {
      this.callbackPort = address.port
    }
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.pendingAuthorizationUrl = authorizationUrl
    if (this.interactive) {
      await this.prepareCallback()
      await this.openExternal(authorizationUrl.toString())
    }
  }

  setInteractive(value: boolean): void { this.interactive = value }
  get authorizationUrl(): URL | undefined { return this.pendingAuthorizationUrl }

  async waitForAuthorizationCode(timeoutMs = 180_000): Promise<string> {
    if (!this.callbackPromise) throw new Error('OAuth authorization was not started.')
    return Promise.race([
      this.callbackPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('OAuth authorization timed out.')), timeoutMs))
    ]).finally(() => this.closeCallbackServer())
  }

  private async closeCallbackServer(): Promise<void> {
    const server = this.callbackServer
    this.callbackServer = undefined
    this.callbackPort = undefined
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  async clear(): Promise<void> { await credentialStore.delete(this.key) }
}

export async function revokeMcpOAuthTokens(
  serverUrl: string,
  tokens: OAuthTokens,
  fetchFn: FetchLike = fetch
): Promise<void> {
  const discovered = await discoverOAuthServerInfo(serverUrl, { fetchFn })
  const metadata = discovered.authorizationServerMetadata
  const endpoint = metadata && 'revocation_endpoint' in metadata
    ? metadata.revocation_endpoint as string | undefined
    : undefined
  if (!endpoint) return
  const revoke = async (token: string | undefined, hint: 'refresh_token' | 'access_token'): Promise<void> => {
    if (!token) return
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, token_type_hint: hint })
    })
    if (!response.ok) throw new Error(`OAuth token revocation failed with HTTP ${response.status}.`)
  }
  let firstError: unknown
  try { await revoke(tokens.refresh_token, 'refresh_token') } catch (error) { firstError = error }
  try { await revoke(tokens.access_token, 'access_token') } catch (error) { firstError ||= error }
  if (firstError) throw firstError
}

const oauthLocks = new Map<string, Promise<unknown>>()

export async function withMcpOAuthLock<T>(identity: string, operation: () => Promise<T>): Promise<T> {
  const previous = oauthLocks.get(identity) || Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  oauthLocks.set(identity, current)
  try {
    return await current
  } finally {
    if (oauthLocks.get(identity) === current) oauthLocks.delete(identity)
  }
}
