export type McpTransport = 'stdio' | 'http' | 'sse'
export type McpScope = 'managed' | 'user' | 'project' | 'local' | 'dynamic'

export interface McpServerConfig {
  type: McpTransport
  description?: string
  enabled?: boolean
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  timeoutMs?: number
  handshakeTimeoutMs?: number
  alwaysLoadTools?: string[]
  blockedTools?: string[]
  samplingPolicy?: 'deny' | 'ask' | 'allow'
  elicitationPolicy?: 'deny' | 'ask' | 'allow'
  samplingMaxTokens?: number
  instructionsPolicy?: 'ignore' | 'tool-hints' | 'approved'
  resourceSubscriptions?: boolean
  [key: string]: unknown
}

export interface ScopedMcpConfig {
  name: string
  scope: McpScope
  config: McpServerConfig
  fingerprint: string
  trusted: boolean
  effective: boolean
  shadowedBy?: McpScope
  policyDisabled?: boolean
}

export interface McpLogEntry {
  timestamp: string
  level: string
  message: string
  data?: unknown
}

export interface McpServerStatus {
  name: string
  scope: McpScope
  state: string
  transport: McpTransport
  toolCount: number
  resourceCount: number
  promptCount: number
  capabilities?: Record<string, unknown>
  serverInfo?: { name: string; version: string; title?: string }
  error?: { code: string; message: string }
  updatedAt: string
  logs: McpLogEntry[]
}

export interface McpToolCatalogItem {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export interface McpResourceCatalogItem {
  server: string
  uri: string
  name: string
  description?: string
  mimeType?: string
  template?: boolean
}

export interface McpPromptCatalogItem {
  server: string
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

export interface McpServerCatalog {
  server: string
  tools: McpToolCatalogItem[]
  resources: McpResourceCatalogItem[]
  prompts: McpPromptCatalogItem[]
  updatedAt?: string
  stale: boolean
}

export interface McpListPayload {
  configs: ScopedMcpConfig[]
  statuses: McpServerStatus[]
}
