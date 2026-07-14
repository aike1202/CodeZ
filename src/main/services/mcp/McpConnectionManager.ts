import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  ResourceUpdatedNotificationSchema,
  type Prompt,
  type Resource,
  type ResourceTemplate,
  type Tool as McpSdkTool
} from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import * as path from 'path'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { pathToFileURL } from 'url'
import log from '../../logger'
import { ToolManager } from '../../tools/ToolManager'
import { McpToolHandler } from '../../tools/mcp/McpToolHandler'
import { McpConfigService } from './McpConfigService'
import { McpOAuthProvider, revokeMcpOAuthTokens, withMcpOAuthLock } from './McpOAuthProvider'
import { McpSecretStore, resolveMcpSecretExpressions, type McpSecretResolver } from './McpSecretStore'
import { collectMcpPages, isolateMcpPrompts, isolateMcpResources, isolateMcpTools } from './discovery'
import { mcpToolName } from './normalization'
import { McpReverseRequestPolicy } from './McpReverseRequestPolicy'
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js'
import { normalizeMcpPromptResult, normalizeMcpResourceResult } from './contentNormalization'
import type { ToolContext } from '../../tools/Tool'
import { createSafeMcpFetch } from './safeFetch'
import { McpRequestGuard } from './McpRequestGuard'
import { getMcpInstructionRegistry } from './McpInstructionRegistry'
import type {
  McpLogEntry,
  McpPromptSummary,
  McpResourceSummary,
  McpServerCatalog,
  McpServerStatus,
  McpToolSummary,
  ScopedMcpServerConfig
} from './types'
import type { McpServerConfig } from './types'

interface McpRuntime {
  scoped: ScopedMcpServerConfig
  serverIdentity: string
  client?: Client
  transport?: Transport
  tools: McpSdkTool[]
  resources: Resource[]
  templates: ResourceTemplate[]
  prompts: Prompt[]
  status: McpServerStatus
  closing: boolean
  reconnectAttempt: number
  reconnectTimer?: NodeJS.Timeout
  refreshTimers?: Partial<Record<'tools' | 'resources' | 'prompts', NodeJS.Timeout>>
  oauthProvider?: McpOAuthProvider
  logWindowStartedAt?: number
  logWindowCount?: number
  droppedLogs?: number
  requestGuard: McpRequestGuard
  subscriptions: Set<string>
}

const execFileAsync = promisify(execFile)

async function terminateStdioProcessTree(transport: Transport | undefined): Promise<void> {
  if (!(transport instanceof StdioClientTransport) || process.platform !== 'win32') return
  const pid = transport.pid
  if (!pid) return
  await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    timeout: 5000
  }).catch(() => undefined)
}

function minimalChildEnvironment(): Record<string, string> {
  const allowed = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'SystemDrive',
    'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL'
  ]
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = process.env[key]
    return value === undefined ? [] : [[key, value]]
  }))
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/unauthorized|401|authorization/i.test(message)) return 'MCP_NEEDS_AUTH'
  if (/timed out/i.test(message)) return 'MCP_HANDSHAKE_TIMEOUT'
  if (/spawn|ENOENT/i.test(message)) return 'MCP_SPAWN_FAILED'
  return 'MCP_CONNECTION_FAILED'
}

export class McpConnectionManager {
  private readonly runtimes = new Map<string, McpRuntime>()
  private readonly listeners = new Set<() => void>()
  private workspaceRoot?: string
  private syncPromise?: Promise<void>
  private readonly redactions = new Map<string, Set<string>>()
  private readonly serverIdentities = new Map<string, string>()
  private readonly catalogCache = new Map<string, McpServerCatalog>()
  private readonly sessionRecoveryPromises = new Map<string, Promise<Client>>()

  constructor(
    private readonly configService = new McpConfigService(),
    private readonly toolManager = new ToolManager(),
    private readonly secretResolver: McpSecretResolver = new McpSecretStore(),
    private readonly reverseRequests = new McpReverseRequestPolicy()
  ) {}

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emitChanged(): void {
    for (const listener of this.listeners) listener()
  }

  getStatuses(): McpServerStatus[] {
    return [...this.runtimes.values()]
      .map((runtime) => ({ ...runtime.status, logs: [...runtime.status.logs] }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async getConfiguration(): Promise<ScopedMcpServerConfig[]> {
    return this.configService.load(this.workspaceRoot)
  }

  async saveUserServers(servers: Record<string, McpServerConfig>): Promise<void> {
    await this.configService.saveUserServers(servers)
    await this.performSync(this.workspaceRoot)
  }

  async setUserServerEnabled(name: string, enabled: boolean): Promise<void> {
    await this.configService.setUserServerEnabled(name, enabled)
    await this.performSync(this.workspaceRoot)
  }

  async setDynamicServer(name: string, config: McpServerConfig): Promise<void> {
    this.configService.setDynamicServer(name, config)
    await this.performSync(this.workspaceRoot)
  }

  async removeDynamicServer(name: string): Promise<void> {
    this.configService.removeDynamicServer(name)
    await this.performSync(this.workspaceRoot)
  }

  async refreshResolvedSecrets(): Promise<void> {
    await this.stopAll()
    await this.performSync(this.workspaceRoot)
  }

  async syncWorkspace(workspaceRoot?: string): Promise<void> {
    const rootsChanged = this.workspaceRoot !== workspaceRoot
    this.workspaceRoot = workspaceRoot
    if (this.syncPromise) return this.syncPromise
    this.syncPromise = this.performSync(workspaceRoot)
      .then(async () => {
        if (!rootsChanged) return
        await Promise.all([...this.runtimes.values()].map((runtime) =>
          runtime.status.state === 'connected'
            ? runtime.client?.sendRootsListChanged().catch(() => undefined)
            : undefined
        ))
      })
      .finally(() => { this.syncPromise = undefined })
    return this.syncPromise
  }

  private async performSync(workspaceRoot?: string): Promise<void> {
    if (process.env.CODEZ_MCP === '0') {
      await this.stopAll()
      return
    }
    const configs = await this.configService.load(workspaceRoot)
    const desired = new Map(configs.filter((config) => config.effective).map((config) => [config.name, config]))
    for (const [name, runtime] of this.runtimes) {
      const next = desired.get(name)
      if (!next || next.fingerprint !== runtime.scoped.fingerprint || next.config.enabled === false) {
        await runtime.oauthProvider?.clear().catch(() => undefined)
        await this.disconnect(name, next?.config.enabled === false ? 'disabled' : 'stopped')
      }
    }
    for (const scoped of desired.values()) {
      if (scoped.config.enabled === false) {
        this.ensurePlaceholder(scoped, 'disabled')
        continue
      }
      if (!scoped.trusted) {
        this.ensurePlaceholder(scoped, 'trust-required')
        continue
      }
      const existing = this.runtimes.get(scoped.name)
      if (existing?.status.state === 'connected' && existing.scoped.fingerprint === scoped.fingerprint) continue
      await this.connect(scoped)
    }
  }

  private ensurePlaceholder(scoped: ScopedMcpServerConfig, state: 'disabled' | 'trust-required'): void {
    const existing = this.runtimes.get(scoped.name)
    if (existing?.scoped.fingerprint === scoped.fingerprint && existing.status.state === state) return
    this.toolManager.unregisterSource(`mcp:${scoped.name}`)
    this.runtimes.set(scoped.name, {
      scoped,
      serverIdentity: scoped.fingerprint,
      tools: [], resources: [], templates: [], prompts: [], closing: false, reconnectAttempt: 0,
      status: this.createStatus(scoped, state),
      requestGuard: new McpRequestGuard(),
      subscriptions: new Set()
    })
    this.emitChanged()
  }

  private createStatus(scoped: ScopedMcpServerConfig, state: McpServerStatus['state']): McpServerStatus {
    return {
      name: scoped.name,
      scope: scoped.scope,
      state,
      fingerprint: scoped.fingerprint,
      transport: scoped.config.type,
      toolCount: 0,
      resourceCount: 0,
      promptCount: 0,
      updatedAt: new Date().toISOString(),
      logs: []
    }
  }

  private async buildTransport(scoped: ScopedMcpServerConfig, oauthProvider?: McpOAuthProvider): Promise<Transport> {
    const config = scoped.config
    const resolve = (value: string) => resolveMcpSecretExpressions(
      value,
      this.secretResolver,
      (secret) => this.rememberRedaction(scoped.name, secret)
    )
    if (config.type === 'stdio') {
      const env = Object.fromEntries(await Promise.all(Object.entries({ ...minimalChildEnvironment(), ...config.env })
        .map(async ([key, value]) => [key, await resolve(value)] as const)))
      const transport = new StdioClientTransport({
        command: await resolve(config.command),
        args: await Promise.all((config.args || []).map(resolve)),
        env,
        cwd: config.cwd ? path.resolve(this.workspaceRoot || process.cwd(), await resolve(config.cwd)) : this.workspaceRoot,
        stderr: 'pipe'
      })
      transport.stderr?.on('data', (chunk) => this.appendLog(scoped.name, 'warning', String(chunk).trim()))
      return transport
    }
    const headers = Object.fromEntries(await Promise.all(
      Object.entries(config.headers || {}).map(async ([key, value]) => [key, await resolve(value)] as const)
    ))
    const safeFetch = createSafeMcpFetch(new URL(config.url).origin, fetch, headers)
    if (config.type === 'http') {
      return new StreamableHTTPClientTransport(new URL(config.url), {
        authProvider: oauthProvider,
        fetch: safeFetch,
        reconnectionOptions: {
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 30_000,
          reconnectionDelayGrowFactor: 2,
          maxRetries: 3
        }
      })
    }
    return new SSEClientTransport(new URL(config.url), {
      authProvider: oauthProvider,
      fetch: safeFetch,
      eventSourceInit: { fetch: safeFetch } as any
    })
  }

  async connect(scoped: ScopedMcpServerConfig, reconnectAttempt = 0): Promise<void> {
    await this.disconnect(scoped.name, 'stopped')
    const runtime: McpRuntime = {
      scoped,
      serverIdentity: scoped.fingerprint,
      tools: [], resources: [], templates: [], prompts: [], closing: false, reconnectAttempt,
      status: this.createStatus(scoped, 'connecting'),
      requestGuard: new McpRequestGuard(),
      subscriptions: new Set()
    }
    this.runtimes.set(scoped.name, runtime)
    this.emitChanged()
    try {
      const clientCapabilities = this.reverseRequests.capabilities(scoped)
      const client = new Client(
        { name: 'codez', title: 'CodeZ', version: '0.1.0' },
        {
          capabilities: clientCapabilities,
          listChanged: {
            tools: { onChanged: (error) => error ? this.failRefresh(runtime, error) : this.scheduleListRefresh(runtime, 'tools') },
            resources: { onChanged: (error) => error ? this.failRefresh(runtime, error) : this.scheduleListRefresh(runtime, 'resources') },
            prompts: { onChanged: (error) => error ? this.failRefresh(runtime, error) : this.scheduleListRefresh(runtime, 'prompts') }
          }
        }
      )
      client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: this.workspaceRoot
          ? [{ uri: pathToFileURL(this.workspaceRoot).href, name: path.basename(this.workspaceRoot) }]
          : []
      }))
      if (clientCapabilities.sampling) {
        client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) =>
          this.reverseRequests.handleSampling(scoped, request, extra.signal)
        )
      }
      if (clientCapabilities.elicitation) {
        client.setRequestHandler(ElicitRequestSchema, async (request) =>
          this.reverseRequests.handleElicitation(scoped, request)
        )
      }
      client.setNotificationHandler(LoggingMessageNotificationSchema, async (notification) => {
        this.appendLog(runtime.scoped.name, notification.params.level, 'MCP server log', notification.params.data)
      })
      if (scoped.config.resourceSubscriptions) {
        client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
          if (!runtime.subscriptions.has(notification.params.uri)) return
          this.appendLog(scoped.name, 'info', `MCP resource updated: ${notification.params.uri.slice(0, 2048)}`)
        })
      }
      const oauthProvider = scoped.config.type === 'stdio'
        ? undefined
        : new McpOAuthProvider(scoped.fingerprint, scoped.name, scoped.config)
      runtime.oauthProvider = oauthProvider
      const transport = await this.buildTransport(
        scoped,
        oauthProvider && await oauthProvider.tokens() ? oauthProvider : undefined
      )
      runtime.client = client
      runtime.transport = transport
      const previousClose = transport.onclose
      transport.onclose = () => {
        previousClose?.()
        if (!runtime.closing) this.scheduleReconnect(runtime)
      }
      const previousError = transport.onerror
      transport.onerror = (error) => {
        previousError?.(error)
        this.appendLog(scoped.name, 'error', error.message)
      }
      await withTimeout(
        client.connect(transport),
        scoped.config.handshakeTimeoutMs || 15_000,
        `MCP server '${scoped.name}' handshake timed out.`
      )
      runtime.reconnectAttempt = 0
      const serverInfo = client.getServerVersion()
      const serverIdentity = createHash('sha256').update(JSON.stringify({
        configFingerprint: scoped.fingerprint,
        serverInfo
      })).digest('hex')
      const previousIdentity = this.serverIdentities.get(scoped.name)
      runtime.serverIdentity = serverIdentity
      this.serverIdentities.set(scoped.name, serverIdentity)
      runtime.status = {
        ...runtime.status,
        state: 'connected',
        capabilities: client.getServerCapabilities(),
        serverInfo,
        updatedAt: new Date().toISOString(),
        error: undefined
      }
      if (previousIdentity && previousIdentity !== serverIdentity) {
        this.appendLog(scoped.name, 'warning', 'MCP server identity changed after reconnect; the next catalog snapshot will use the new identity.')
      }
      const instructions = client.getInstructions()
      const instructionsPolicy = scoped.config.instructionsPolicy || 'tool-hints'
      if (instructions && instructionsPolicy !== 'ignore') {
        getMcpInstructionRegistry().update({
          serverName: scoped.name,
          serverIdentity,
          policy: instructionsPolicy,
          instructions
        })
      } else {
        getMcpInstructionRegistry().remove(scoped.name)
      }
      await this.refreshAll(runtime)
      this.appendLog(scoped.name, 'info', 'Connected')
      this.emitChanged()
    } catch (error: any) {
      const message = error?.message || String(error)
      runtime.status = {
        ...runtime.status,
        state: errorCode(error) === 'MCP_NEEDS_AUTH' ? 'needs-auth' : 'failed',
        error: { code: errorCode(error), message },
        updatedAt: new Date().toISOString()
      }
      this.appendLog(scoped.name, 'error', message)
      await runtime.client?.close().catch(() => undefined)
      this.emitChanged()
      if (!runtime.closing && runtime.status.state === 'failed') this.scheduleReconnect(runtime)
    }
  }

  private failRefresh(runtime: McpRuntime, error: Error): void {
    this.appendLog(runtime.scoped.name, 'error', `List refresh failed: ${error.message}`)
  }

  private scheduleListRefresh(
    runtime: McpRuntime,
    kind: 'tools' | 'resources' | 'prompts'
  ): void {
    runtime.refreshTimers ||= {}
    if (runtime.refreshTimers[kind]) clearTimeout(runtime.refreshTimers[kind])
    runtime.refreshTimers[kind] = setTimeout(() => {
      delete runtime.refreshTimers?.[kind]
      if (this.runtimes.get(runtime.scoped.name) !== runtime || runtime.closing) return
      void this.refreshList(runtime, kind).catch((error) => this.failRefresh(
        runtime,
        error instanceof Error ? error : new Error(String(error))
      ))
    }, 100)
  }

  private async refreshList(runtime: McpRuntime, kind: 'tools' | 'resources' | 'prompts'): Promise<void> {
    if (!runtime.client || this.runtimes.get(runtime.scoped.name) !== runtime || runtime.closing) return
    const timeout = runtime.scoped.config.timeoutMs || 60_000
    if (kind === 'tools') {
      const tools = await collectMcpPages<McpSdkTool>(
        (cursor) => runtime.requestGuard.run(() => runtime.client!.listTools(
          cursor ? { cursor } : undefined,
          { timeout }
        )),
        'tools'
      )
      if (this.runtimes.get(runtime.scoped.name) === runtime && !runtime.closing) this.applyTools(runtime, tools)
      return
    }
    if (kind === 'prompts') {
      const prompts = await collectMcpPages<Prompt>(
        (cursor) => runtime.requestGuard.run(() => runtime.client!.listPrompts(
          cursor ? { cursor } : undefined,
          { timeout }
        )),
        'prompts'
      )
      if (this.runtimes.get(runtime.scoped.name) === runtime && !runtime.closing) this.applyPrompts(runtime, prompts)
      return
    }
    const [resources, templates] = await Promise.all([
      collectMcpPages<Resource>(
        (cursor) => runtime.requestGuard.run(() => runtime.client!.listResources(
          cursor ? { cursor } : undefined,
          { timeout }
        )),
        'resources'
      ),
      collectMcpPages<ResourceTemplate>(
        (cursor) => runtime.requestGuard.run(() => runtime.client!.listResourceTemplates(
          cursor ? { cursor } : undefined,
          { timeout }
        )),
        'resourceTemplates'
      )
    ])
    if (this.runtimes.get(runtime.scoped.name) === runtime && !runtime.closing) {
      this.applyResources(runtime, resources, templates)
    }
  }

  private async refreshAll(runtime: McpRuntime): Promise<void> {
    const capabilities = runtime.client?.getServerCapabilities()
    if (!runtime.client) return
    const timeout = runtime.scoped.config.timeoutMs || 60_000
    const [tools, resources, templates, prompts] = await Promise.all([
      capabilities?.tools ? collectMcpPages<McpSdkTool>((cursor) => runtime.requestGuard.run(() => runtime.client!.listTools(cursor ? { cursor } : undefined, { timeout })), 'tools') : [],
      capabilities?.resources ? collectMcpPages<Resource>((cursor) => runtime.requestGuard.run(() => runtime.client!.listResources(cursor ? { cursor } : undefined, { timeout })), 'resources') : [],
      capabilities?.resources ? collectMcpPages<ResourceTemplate>((cursor) => runtime.requestGuard.run(() => runtime.client!.listResourceTemplates(cursor ? { cursor } : undefined, { timeout })), 'resourceTemplates') : [],
      capabilities?.prompts ? collectMcpPages<Prompt>((cursor) => runtime.requestGuard.run(() => runtime.client!.listPrompts(cursor ? { cursor } : undefined, { timeout })), 'prompts') : []
    ])
    this.applyTools(runtime, tools)
    this.applyResources(runtime, resources, templates)
    this.applyPrompts(runtime, prompts)
  }

  private applyTools(runtime: McpRuntime, tools: McpSdkTool[]): void {
    const isolated = isolateMcpTools(runtime.scoped.name, tools)
    const blocked = new Set(runtime.scoped.config.blockedTools || [])
    runtime.tools = isolated.tools.filter((tool) =>
      !blocked.has(tool.name) && !blocked.has(mcpToolName(runtime.scoped.name, tool.name))
    )
    for (const rejection of isolated.rejected) {
      this.appendLog(runtime.scoped.name, 'warning', `Ignored MCP tool '${rejection.toolName}': ${rejection.reason}`)
    }
    this.toolManager.unregisterSource(`mcp:${runtime.scoped.name}`)
    const always = new Set(runtime.scoped.config.alwaysLoadTools || [])
    for (const tool of runtime.tools) {
      this.toolManager.registerHandler(new McpToolHandler(
        runtime.scoped.name,
        runtime.serverIdentity,
        tool,
        runtime.client!,
        runtime.requestGuard,
        runtime.scoped.config.timeoutMs,
        always.has(tool.name),
        (progress) => this.appendLog(
          runtime.scoped.name,
          'debug',
          `Tool '${tool.name}' progress ${progress.progress}${progress.total ? `/${progress.total}` : ''}`,
          progress.message
        ),
        runtime.scoped.config.type === 'http'
          ? (failedClient) => this.recoverExpiredHttpSession(runtime.scoped.name, failedClient)
          : undefined,
        runtime.scoped.config.type !== 'stdio'
          ? (error) => this.markAuthRequired(runtime.scoped.name, error)
          : undefined
      ))
    }
    runtime.status.toolCount = runtime.tools.length
    runtime.status.updatedAt = new Date().toISOString()
    this.rememberCatalog(runtime)
    this.emitChanged()
  }

  private async recoverExpiredHttpSession(name: string, failedClient: Client): Promise<Client> {
    const current = this.runtimes.get(name)
    if (current?.client && current.client !== failedClient && current.status.state === 'connected') {
      return current.client
    }
    const pending = this.sessionRecoveryPromises.get(name)
    if (pending) return pending

    const recovery = (async () => {
      const stale = this.runtimes.get(name)
      if (!stale || stale.scoped.config.type !== 'http') {
        throw new Error(`MCP HTTP server '${name}' is not configured.`)
      }
      this.appendLog(name, 'warning', 'MCP HTTP session expired; reconnecting with a fresh session.')
      await this.connect(stale.scoped)
      const recovered = this.runtimes.get(name)
      if (!recovered?.client || recovered.status.state !== 'connected') {
        throw new Error(`MCP HTTP server '${name}' failed to recover its expired session.`)
      }
      this.appendLog(name, 'info', 'MCP HTTP session recovered with a fresh session.')
      return recovered.client
    })()
    this.sessionRecoveryPromises.set(name, recovery)
    try {
      return await recovery
    } finally {
      if (this.sessionRecoveryPromises.get(name) === recovery) {
        this.sessionRecoveryPromises.delete(name)
      }
    }
  }

  private markAuthRequired(name: string, error: unknown): void {
    const runtime = this.runtimes.get(name)
    if (!runtime || runtime.closing) return
    runtime.status.state = 'needs-auth'
    runtime.status.error = {
      code: 'MCP_NEEDS_AUTH',
      message: `MCP server '${name}' requires re-authorization.`
    }
    runtime.status.updatedAt = new Date().toISOString()
    this.toolManager.unregisterSource(`mcp:${name}`)
    getMcpInstructionRegistry().remove(name)
    this.appendLog(name, 'warning', 'MCP authorization expired; re-authorization is required.', error)
    this.emitChanged()
  }

  private applyResources(runtime: McpRuntime, resources: Resource[], templates: ResourceTemplate[] = runtime.templates): void {
    const isolated = isolateMcpResources(resources, templates)
    runtime.resources = isolated.resources
    runtime.templates = isolated.templates
    for (const rejection of isolated.rejected) {
      this.appendLog(runtime.scoped.name, 'warning', `Ignored MCP resource '${rejection.identity}': ${rejection.reason}`)
    }
    runtime.status.resourceCount = runtime.resources.length + runtime.templates.length
    runtime.status.updatedAt = new Date().toISOString()
    this.rememberCatalog(runtime)
    this.emitChanged()
  }

  private applyPrompts(runtime: McpRuntime, prompts: Prompt[]): void {
    const isolated = isolateMcpPrompts(prompts)
    runtime.prompts = isolated.prompts
    for (const rejection of isolated.rejected) {
      this.appendLog(runtime.scoped.name, 'warning', `Ignored MCP prompt '${rejection.name}': ${rejection.reason}`)
    }
    runtime.status.promptCount = runtime.prompts.length
    runtime.status.updatedAt = new Date().toISOString()
    this.rememberCatalog(runtime)
    this.emitChanged()
  }

  private rememberCatalog(runtime: McpRuntime): void {
    const tools: McpToolSummary[] = runtime.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      outputSchema: tool.outputSchema as Record<string, unknown> | undefined,
      annotations: tool.annotations as Record<string, unknown> | undefined
    }))
    this.catalogCache.set(runtime.scoped.name, {
      server: runtime.scoped.name,
      tools,
      resources: [
        ...runtime.resources.map((resource) => ({ server: runtime.scoped.name, ...resource })),
        ...runtime.templates.map((template) => ({
          server: runtime.scoped.name,
          uri: template.uriTemplate,
          name: template.name,
          description: template.description,
          mimeType: template.mimeType,
          template: true as const
        }))
      ],
      prompts: runtime.prompts.map((prompt) => ({
        server: runtime.scoped.name,
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments
      })),
      updatedAt: runtime.status.updatedAt,
      stale: false
    })
  }

  getCatalog(name: string): McpServerCatalog {
    const cached = this.catalogCache.get(name)
    const runtime = this.runtimes.get(name)
    if (!cached) {
      return { server: name, tools: [], resources: [], prompts: [], stale: runtime?.status.state !== 'connected' }
    }
    return {
      ...cached,
      tools: cached.tools.map((tool) => ({ ...tool })),
      resources: cached.resources.map((resource) => ({ ...resource })),
      prompts: cached.prompts.map((prompt) => ({
        ...prompt,
        arguments: prompt.arguments?.map((argument) => ({ ...argument }))
      })),
      stale: runtime?.status.state !== 'connected'
    }
  }

  private appendLog(name: string, level: McpLogEntry['level'], message: string, data?: unknown): void {
    const runtime = this.runtimes.get(name)
    if (!runtime || (!message && data === undefined)) return
    const now = Date.now()
    if (!runtime.logWindowStartedAt || now - runtime.logWindowStartedAt >= 1000) {
      if (runtime.droppedLogs) {
        runtime.status.logs.push({
          timestamp: new Date().toISOString(),
          level: 'warning',
          message: `Dropped ${runtime.droppedLogs} MCP log messages due to rate limiting.`
        })
      }
      runtime.logWindowStartedAt = now
      runtime.logWindowCount = 0
      runtime.droppedLogs = 0
    }
    runtime.logWindowCount = (runtime.logWindowCount || 0) + 1
    if (runtime.logWindowCount > 100) {
      runtime.droppedLogs = (runtime.droppedLogs || 0) + 1
      return
    }
    const safeMessage = this.redact(name, message).slice(0, 8192)
    const safeData = this.redactValue(name, data)
    runtime.status.logs.push({ timestamp: new Date().toISOString(), level, message: safeMessage, data: safeData })
    if (runtime.status.logs.length > 200) runtime.status.logs.splice(0, runtime.status.logs.length - 200)
    if (message !== 'MCP server log') {
      log.info('[MCP]', { server: name, level, message: safeMessage.slice(0, 1000) })
    }
    this.emitChanged()
  }

  private rememberRedaction(name: string, value: string): void {
    if (!value || value.length < 4) return
    const values = this.redactions.get(name) || new Set<string>()
    values.add(value)
    this.redactions.set(name, values)
  }

  private redact(name: string, value: string): string {
    let safe = value
    for (const secret of this.redactions.get(name) || []) safe = safe.split(secret).join('[REDACTED]')
    return safe
  }

  private redactValue(name: string, value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return this.redact(name, value).slice(0, 8192)
    if (depth > 5 || value === null || value === undefined || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => this.redactValue(name, item, depth + 1))
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, item]) => [key, this.redactValue(name, item, depth + 1)]))
  }

  private scheduleReconnect(runtime: McpRuntime): void {
    if (
      runtime.reconnectTimer ||
      runtime.closing ||
      runtime.status.state === 'needs-auth' ||
      runtime.scoped.config.enabled === false
    ) return
    const policy = runtime.scoped.config.reconnect || {
      enabled: true, maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 30_000
    }
    if (!policy.enabled) return
    if (runtime.reconnectAttempt >= policy.maxAttempts) {
      runtime.status.state = 'failed'
      runtime.status.error = {
        code: 'MCP_RECONNECT_EXHAUSTED',
        message: `Reconnect attempts exhausted for MCP server '${runtime.scoped.name}'.`
      }
      runtime.status.nextRetryAt = undefined
      this.emitChanged()
      return
    }
    runtime.status.state = 'reconnecting'
    runtime.status.updatedAt = new Date().toISOString()
    const delay = Math.min(policy.maxDelayMs, Math.round(policy.baseDelayMs * 2 ** runtime.reconnectAttempt * (0.8 + Math.random() * 0.4)))
    runtime.reconnectAttempt++
    runtime.status.nextRetryAt = new Date(Date.now() + delay).toISOString()
    runtime.reconnectTimer = setTimeout(() => {
      runtime.reconnectTimer = undefined
      if (this.runtimes.get(runtime.scoped.name) !== runtime || runtime.closing) return
      void this.connect(runtime.scoped, runtime.reconnectAttempt)
    }, delay)
    this.emitChanged()
  }

  async disconnect(name: string, state: 'disabled' | 'stopped' = 'stopped'): Promise<void> {
    const runtime = this.runtimes.get(name)
    this.toolManager.unregisterSource(`mcp:${name}`)
    getMcpInstructionRegistry().remove(name)
    if (!runtime) return
    runtime.closing = true
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer)
    for (const timer of Object.values(runtime.refreshTimers || {})) clearTimeout(timer)
    await Promise.all([...runtime.subscriptions].map((uri) =>
      runtime.client?.unsubscribeResource({ uri }).catch(() => undefined)
    ))
    runtime.subscriptions.clear()
    if (runtime.transport instanceof StreamableHTTPClientTransport) {
      await runtime.transport.terminateSession().catch(() => undefined)
    }
    await terminateStdioProcessTree(runtime.transport)
    await runtime.client?.close().catch(() => undefined)
    runtime.status.state = state
    runtime.status.updatedAt = new Date().toISOString()
    this.runtimes.delete(name)
    this.redactions.delete(name)
    this.emitChanged()
  }

  async reconnect(name: string): Promise<void> {
    const runtime = this.runtimes.get(name)
    if (!runtime) throw new Error(`MCP server '${name}' is not configured.`)
    await this.connect(runtime.scoped)
  }

  async authorize(name: string): Promise<void> {
    if (process.env.CODEZ_MCP_OAUTH === '0') throw new Error('MCP OAuth is disabled by CODEZ_MCP_OAUTH=0.')
    const runtime = this.runtimes.get(name)
    if (!runtime || runtime.scoped.config.type === 'stdio') {
      throw new Error(`MCP server '${name}' does not support interactive OAuth.`)
    }
    const remoteConfig = runtime.scoped.config
    const provider = runtime.oauthProvider || new McpOAuthProvider(
      runtime.scoped.fingerprint,
      runtime.scoped.name,
      runtime.scoped.config
    )
    await withMcpOAuthLock(runtime.scoped.fingerprint, async () => {
      provider.setInteractive(true)
      try {
        await provider.prepareCallback()
        const serverUrl = remoteConfig.url
        const first = await auth(provider, {
          serverUrl,
          scope: remoteConfig.oauth?.scope,
          fetchFn: createSafeMcpFetch(new URL(serverUrl).origin)
        })
        if (first === 'REDIRECT') {
          const code = await provider.waitForAuthorizationCode()
          await auth(provider, {
            serverUrl,
            authorizationCode: code,
            scope: remoteConfig.oauth?.scope,
            fetchFn: createSafeMcpFetch(new URL(serverUrl).origin)
          })
        }
        await this.connect(runtime.scoped)
      } finally {
        provider.setInteractive(false)
      }
    })
  }

  async logout(name: string): Promise<void> {
    const runtime = this.runtimes.get(name)
    if (!runtime || runtime.scoped.config.type === 'stdio') return
    const remoteConfig = runtime.scoped.config
    const provider = runtime.oauthProvider || new McpOAuthProvider(
      runtime.scoped.fingerprint,
      runtime.scoped.name,
      runtime.scoped.config
    )
    await withMcpOAuthLock(runtime.scoped.fingerprint, async () => {
      const tokens = await provider.tokens()
      try {
        if (tokens) {
          await revokeMcpOAuthTokens(
            remoteConfig.url,
            tokens,
            createSafeMcpFetch(new URL(remoteConfig.url).origin)
          )
        }
      } finally {
        await provider.clear()
        await this.connect(runtime.scoped)
      }
    })
  }

  async trustProject(fingerprint: string): Promise<void> {
    await this.configService.trustProjectFingerprint(fingerprint)
    await this.performSync(this.workspaceRoot)
  }

  listResources(): McpResourceSummary[] {
    return [...this.runtimes.values()].flatMap((runtime) => [
      ...runtime.resources.map((resource) => ({ server: runtime.scoped.name, ...resource })),
      ...runtime.templates.map((template) => ({
        server: runtime.scoped.name,
        uri: template.uriTemplate,
        name: template.name,
        description: template.description,
        mimeType: template.mimeType,
        template: true as const
      }))
    ])
  }

  async readResource(server: string, uri: string, context: ToolContext): Promise<unknown> {
    const runtime = this.requireConnected(server)
    if (!this.isAdvertisedResource(runtime, uri)) {
      throw new Error(`MCP resource URI '${uri}' was not advertised by server '${server}'.`)
    }
    const result = await runtime.requestGuard.run(() => runtime.client!.readResource(
      { uri },
      { signal: context.abortSignal, timeout: runtime.scoped.config.timeoutMs || 60_000 }
    ))
    return normalizeMcpResourceResult(result, context, server)
  }

  private isAdvertisedResource(runtime: McpRuntime, uri: string): boolean {
    if (!uri || uri.length > 8192 || /[\u0000-\u001f]/.test(uri)) return false
    if (runtime.resources.some((resource) => resource.uri === uri)) return true
    return runtime.templates.some((template) => {
      try { return new UriTemplate(template.uriTemplate).match(uri) !== null } catch { return false }
    })
  }

  async subscribeResource(server: string, uri: string): Promise<void> {
    const runtime = this.requireConnected(server)
    if (!runtime.scoped.config.resourceSubscriptions) throw new Error('MCP resource subscriptions are disabled for this server.')
    if (!runtime.client?.getServerCapabilities()?.resources?.subscribe) throw new Error('MCP server does not support resource subscriptions.')
    if (!this.isAdvertisedResource(runtime, uri)) throw new Error('MCP resource URI was not advertised by this server.')
    await runtime.client.subscribeResource({ uri })
    runtime.subscriptions.add(uri)
  }

  async unsubscribeResource(server: string, uri: string): Promise<void> {
    const runtime = this.requireConnected(server)
    if (!runtime.subscriptions.delete(uri)) return
    await runtime.client!.unsubscribeResource({ uri })
  }

  listPrompts(): McpPromptSummary[] {
    return [...this.runtimes.values()].flatMap((runtime) => runtime.prompts.map((prompt) => ({
      server: runtime.scoped.name,
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments
    })))
  }

  async getPrompt(
    server: string,
    name: string,
    args?: Record<string, string>,
    context?: ToolContext
  ): Promise<unknown> {
    const runtime = this.requireConnected(server)
    if (!runtime.prompts.some((prompt) => prompt.name === name)) {
      throw new Error(`MCP prompt '${name}' was not advertised by server '${server}'.`)
    }
    const result = await runtime.requestGuard.run(() => runtime.client!.getPrompt(
      { name, arguments: args },
      { signal: context?.abortSignal, timeout: runtime.scoped.config.timeoutMs || 60_000 }
    ))
    return normalizeMcpPromptResult(result)
  }

  private requireConnected(name: string): McpRuntime {
    const runtime = this.runtimes.get(name)
    if (!runtime?.client || runtime.status.state !== 'connected') {
      throw new Error(`MCP server '${name}' is not connected.`)
    }
    return runtime
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((name) => this.disconnect(name)))
  }
}

let singleton: McpConnectionManager | undefined

export function getMcpConnectionManager(): McpConnectionManager {
  if (!singleton) singleton = new McpConnectionManager()
  return singleton
}
