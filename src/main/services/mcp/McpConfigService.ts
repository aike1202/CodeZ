import { createHash } from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'
import type { McpServerConfig, ScopedMcpServerConfig } from './types'
import { atomicWriteSecureJson } from '../context/atomicFile'
import { normalizeMcpName } from './normalization'

interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>
  servers?: Record<string, McpServerConfig>
  denyServers?: string[]
}
interface TrustFile { trustedFingerprints?: string[] }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function assertStringMap(name: string, field: string, value: unknown): void {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.values(value).some((item) => typeof item !== 'string')) {
    throw new Error(`${name}: ${field} must be a string map`)
  }
}

function assertSecretExpressions(name: string, field: string, values: Record<string, string> | undefined): void {
  for (const [key, value] of Object.entries(values || {})) {
    const withoutExpressions = value.replace(/\$\{env:[A-Za-z_][A-Za-z0-9_]*\}|\$\{secret:[A-Za-z0-9_.-]{1,128}\}/g, '')
    if (withoutExpressions.includes('${')) throw new Error(`${name}: ${field}.${key} contains an invalid secret expression`)
    if (/(authorization|cookie|token|secret|password|api[-_]?key)/i.test(key) && !/\$\{(?:env|secret):/.test(value)) {
      throw new Error(`${name}: ${field}.${key} must use an env or secure-secret expression`)
    }
  }
}

function assertOptionalNumber(name: string, field: string, value: unknown, minimum: number, maximum: number): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name}: ${field} must be an integer between ${minimum} and ${maximum}`)
  }
}

function validateServer(name: string, raw: unknown): McpServerConfig {
  if (!name.trim() || name.length > 128 || /[\u0000-\u001f]/.test(name)) throw new Error('MCP server name is invalid')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${name}: config must be an object`)
  const value = raw as Record<string, unknown>
  if (value.description !== undefined &&
      (typeof value.description !== 'string' || value.description.length > 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.description))) {
    throw new Error(`${name}: description must be a string of at most 1024 characters`)
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error(`${name}: enabled must be a boolean`)
  if (value.autoStart !== undefined && typeof value.autoStart !== 'boolean') throw new Error(`${name}: autoStart must be a boolean`)
  if (value.resourceSubscriptions !== undefined && typeof value.resourceSubscriptions !== 'boolean') {
    throw new Error(`${name}: resourceSubscriptions must be a boolean`)
  }
  assertOptionalNumber(name, 'timeoutMs', value.timeoutMs, 100, 600_000)
  assertOptionalNumber(name, 'handshakeTimeoutMs', value.handshakeTimeoutMs, 100, 120_000)
  if (value.reconnect !== undefined) {
    if (!value.reconnect || typeof value.reconnect !== 'object' || Array.isArray(value.reconnect)) throw new Error(`${name}: reconnect must be an object`)
    const reconnect = value.reconnect as Record<string, unknown>
    if (typeof reconnect.enabled !== 'boolean') throw new Error(`${name}: reconnect.enabled must be a boolean`)
    for (const field of ['maxAttempts', 'baseDelayMs', 'maxDelayMs']) {
      if (reconnect[field] === undefined) throw new Error(`${name}: reconnect.${field} is required`)
    }
    assertOptionalNumber(name, 'reconnect.maxAttempts', reconnect.maxAttempts, 0, 100)
    assertOptionalNumber(name, 'reconnect.baseDelayMs', reconnect.baseDelayMs, 10, 60_000)
    assertOptionalNumber(name, 'reconnect.maxDelayMs', reconnect.maxDelayMs, 10, 300_000)
    if (Number(reconnect.maxDelayMs) < Number(reconnect.baseDelayMs)) throw new Error(`${name}: reconnect.maxDelayMs must be at least baseDelayMs`)
  }
  if (value.samplingPolicy !== undefined && !['deny', 'ask', 'allow'].includes(String(value.samplingPolicy))) {
    throw new Error(`${name}: invalid samplingPolicy`)
  }
  if (value.elicitationPolicy !== undefined && !['deny', 'ask', 'allow'].includes(String(value.elicitationPolicy))) {
    throw new Error(`${name}: invalid elicitationPolicy`)
  }
  assertOptionalNumber(name, 'samplingMaxTokens', value.samplingMaxTokens, 1, 16_384)
  if (value.instructionsPolicy !== undefined && !['ignore', 'tool-hints', 'approved'].includes(String(value.instructionsPolicy))) {
    throw new Error(`${name}: invalid instructionsPolicy`)
  }
  const type = value.type || (value.command ? 'stdio' : undefined)
  if (type === 'stdio') {
    if (typeof value.command !== 'string' || !value.command.trim()) throw new Error(`${name}: stdio command is required`)
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((item) => typeof item !== 'string'))) {
      throw new Error(`${name}: args must be a string array`)
    }
    assertStringMap(name, 'env', value.env)
    assertSecretExpressions(name, 'env', value.env as Record<string, string> | undefined)
    const executable = path.basename(value.command).toLowerCase().replace(/\.exe$/, '')
    const args = Array.isArray(value.args) ? value.args.map(String) : []
    for (let index = 0; index < args.length; index++) {
      const argument = args[index]
      if (/^--?(?:token|secret|password|api[-_]?key)(?:=|$)/i.test(argument) &&
          !/\$\{(?:env|secret):/.test(argument) &&
          !(!argument.includes('=') && /\$\{(?:env|secret):/.test(args[index + 1] || ''))) {
        throw new Error(`${name}: sensitive stdio arguments must use an env or secure-secret expression`)
      }
    }
    if (['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh'].includes(executable) &&
        args.some((arg) => ['/c', '-c', '-command', '-encodedcommand'].includes(arg.toLowerCase()))) {
      throw new Error(`${name}: shell command-string execution is not allowed for MCP stdio servers`)
    }
    return { ...value, type: 'stdio' } as McpServerConfig
  }
  if (type === 'http' || type === 'sse') {
    if (typeof value.url !== 'string') throw new Error(`${name}: URL is required`)
    const url = new URL(value.url)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${name}: URL must use http or https`)
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    if (url.protocol !== 'https:' && !loopback) throw new Error(`${name}: remote MCP URLs must use HTTPS`)
    if (url.protocol !== 'https:' && value.oauth) throw new Error(`${name}: OAuth is not allowed over insecure HTTP`)
    if (url.username || url.password) throw new Error(`${name}: credentials are not allowed in MCP URLs`)
    assertStringMap(name, 'headers', value.headers)
    assertSecretExpressions(name, 'headers', value.headers as Record<string, string> | undefined)
    return { ...value, type } as McpServerConfig
  }
  throw new Error(`${name}: unsupported transport type`)
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')) as T } catch { return fallback }
}

async function readConfigFile(filePath: string, rejectSymlink = false): Promise<McpConfigFile> {
  try {
    const before = await fs.lstat(filePath)
    if (rejectSymlink && before.isSymbolicLink()) throw new Error('symbolic-link MCP configuration is not allowed')
    if (!before.isFile()) throw new Error('MCP configuration is not a regular file')
    if (before.size > 1024 * 1024) throw new Error('MCP configuration exceeds the 1 MiB limit')
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as McpConfigFile
    const after = await fs.lstat(filePath)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('MCP configuration changed while it was being read')
    }
    return parsed
  } catch (error: any) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`Invalid MCP configuration '${filePath}': ${error?.message || String(error)}`)
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function resolveStableWorkspacePath(root: string, candidate: string, field: string): Promise<string> {
  const resolved = path.resolve(root, candidate)
  if (!isWithin(root, resolved)) throw new Error(`${field} must stay inside the workspace`)
  try {
    const real = await fs.realpath(resolved)
    if (!isWithin(root, real)) throw new Error(`${field} resolves outside the workspace`)
    return real
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new Error(`${field} does not exist: ${candidate}`)
    throw error
  }
}

async function normalizeWorkspaceConfig(root: string, config: McpServerConfig): Promise<McpServerConfig> {
  if (config.type !== 'stdio') return config
  const normalized = { ...config }
  if (normalized.cwd) normalized.cwd = await resolveStableWorkspacePath(root, normalized.cwd, 'MCP stdio cwd')
  const commandLooksLikePath = path.isAbsolute(normalized.command) || normalized.command.includes('/') || normalized.command.includes('\\')
  if (commandLooksLikePath) {
    normalized.command = path.isAbsolute(normalized.command)
      ? await resolveStableWorkspacePath(root, path.relative(root, normalized.command), 'MCP stdio command')
      : await resolveStableWorkspacePath(root, normalized.command, 'MCP stdio command')
  }
  return normalized
}

export class McpConfigService {
  private readonly userConfigPath: string
  private readonly trustPath: string
  private readonly managedConfigPath?: string
  private readonly dynamicServers = new Map<string, McpServerConfig>()

  constructor(userDataPath = app.getPath('userData'), managedConfigPath = process.env.CODEZ_MCP_MANAGED_CONFIG) {
    this.userConfigPath = path.join(userDataPath, 'mcp.json')
    this.trustPath = path.join(userDataPath, 'mcp-project-trust.json')
    this.managedConfigPath = managedConfigPath
  }

  async load(workspaceRoot?: string): Promise<ScopedMcpServerConfig[]> {
    const user = await readConfigFile(this.userConfigPath)
    const canonicalWorkspace = workspaceRoot ? await fs.realpath(path.resolve(workspaceRoot)) : undefined
    const projectPath = canonicalWorkspace ? path.join(canonicalWorkspace, '.mcp.json') : undefined
    const project = projectPath ? await readConfigFile(projectPath, true) : {}
    const localPath = canonicalWorkspace ? path.join(canonicalWorkspace, '.codez', 'mcp.local.json') : undefined
    const local = localPath ? await readConfigFile(localPath, true) : {}
    const managed = this.managedConfigPath ? await readConfigFile(this.managedConfigPath) : {}
    const dynamic: McpConfigFile = { mcpServers: Object.fromEntries(this.dynamicServers) }
    const trust = await readJson<TrustFile>(this.trustPath, {})
    const trusted = new Set(trust.trustedFingerprints || [])
    const result: ScopedMcpServerConfig[] = []
    for (const [scope, source] of [
      ['user', user], ['project', project], ['local', local], ['dynamic', dynamic], ['managed', managed]
    ] as const) {
      const servers = source.mcpServers || source.servers || {}
      for (const [name, raw] of Object.entries(servers)) {
        let config = validateServer(name, raw)
        if (canonicalWorkspace && (scope === 'project' || scope === 'local')) {
          config = await normalizeWorkspaceConfig(canonicalWorkspace, config)
        }
        const serverFingerprint = fingerprint({
          workspaceRoot: scope === 'project' ? canonicalWorkspace : undefined,
          name,
          scope,
          config
        })
        result.push({
          name,
          scope,
          config,
          fingerprint: serverFingerprint,
          trusted: scope !== 'project' || trusted.has(serverFingerprint),
          effective: true
        })
      }
    }
    const effective = new Map<string, ScopedMcpServerConfig>()
    for (const item of result) {
      const previous = effective.get(item.name)
      if (previous) {
        previous.shadowedBy = item.scope
        previous.effective = false
      }
      effective.set(item.name, item)
    }
    for (const deniedName of managed.denyServers || []) {
      for (const item of result.filter((candidate) => candidate.name === deniedName)) {
        item.shadowedBy = 'managed'
        item.policyDisabled = true
      }
      const selected = effective.get(deniedName)
      if (selected) selected.config = { ...selected.config, enabled: false }
    }
    const normalizedEffectiveNames = new Map<string, string>()
    for (const item of effective.values()) {
      const normalized = normalizeMcpName(item.name)
      const previous = normalizedEffectiveNames.get(normalized)
      if (previous && previous !== item.name) {
        throw new Error(`MCP server names '${previous}' and '${item.name}' normalize to the same identity.`)
      }
      normalizedEffectiveNames.set(normalized, item.name)
    }
    return result
  }

  async saveUserServers(servers: Record<string, McpServerConfig>): Promise<void> {
    for (const [name, config] of Object.entries(servers)) validateServer(name, config)
    await atomicWriteSecureJson(this.userConfigPath, { mcpServers: servers })
  }

  async setUserServerEnabled(name: string, enabled: boolean): Promise<void> {
    const source = await readConfigFile(this.userConfigPath)
    const servers = { ...(source.mcpServers || source.servers || {}) }
    const current = servers[name]
    if (!current) throw new Error(`MCP server '${name}' is not configured in the user scope.`)
    servers[name] = { ...validateServer(name, current), enabled }
    await this.saveUserServers(servers)
  }

  setDynamicServer(name: string, config: McpServerConfig): void {
    this.dynamicServers.set(name, validateServer(name, config))
  }

  removeDynamicServer(name: string): void { this.dynamicServers.delete(name) }
  clearDynamicServers(): void { this.dynamicServers.clear() }

  async trustProjectFingerprint(value: string): Promise<void> {
    const trust = await readJson<TrustFile>(this.trustPath, {})
    const next = new Set(trust.trustedFingerprints || [])
    next.add(value)
    await atomicWriteSecureJson(this.trustPath, { trustedFingerprints: [...next] })
  }
}
