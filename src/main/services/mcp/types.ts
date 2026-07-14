import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js'

export type McpTransportType = 'stdio' | 'http' | 'sse'
export type McpConfigScope = 'managed' | 'user' | 'project' | 'local' | 'dynamic'

interface McpServerConfigBase {
  type: McpTransportType
  description?: string
  enabled?: boolean
  timeoutMs?: number
  handshakeTimeoutMs?: number
  alwaysLoadTools?: string[]
  blockedTools?: string[]
  autoStart?: boolean
  reconnect?: {
    enabled: boolean
    maxAttempts: number
    baseDelayMs: number
    maxDelayMs: number
  }
  instructionsPolicy?: 'ignore' | 'tool-hints' | 'approved'
  samplingPolicy?: 'deny' | 'ask' | 'allow'
  elicitationPolicy?: 'deny' | 'ask' | 'allow'
  samplingMaxTokens?: number
  resourceSubscriptions?: boolean
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  type: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface McpRemoteServerConfig extends McpServerConfigBase {
  type: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
  oauth?: {
    clientId?: string
    callbackPort?: number
    scope?: string
  }
}

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig

export interface ScopedMcpServerConfig {
  name: string
  scope: McpConfigScope
  config: McpServerConfig
  fingerprint: string
  trusted: boolean
  effective: boolean
  shadowedBy?: McpConfigScope
  policyDisabled?: boolean
}

export type McpServerState =
  | 'disabled'
  | 'trust-required'
  | 'connecting'
  | 'connected'
  | 'needs-auth'
  | 'reconnecting'
  | 'failed'
  | 'stopped'

export interface McpServerStatus {
  name: string
  scope: McpConfigScope
  state: McpServerState
  fingerprint: string
  transport: McpTransportType
  capabilities?: ServerCapabilities
  serverInfo?: { name: string; version: string; title?: string }
  toolCount: number
  resourceCount: number
  promptCount: number
  error?: { code: string; message: string }
  nextRetryAt?: string
  updatedAt: string
  logs: McpLogEntry[]
}

export interface McpLogEntry {
  timestamp: string
  level: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency'
  message: string
  data?: unknown
}

export interface McpResourceSummary {
  server: string
  uri: string
  name: string
  description?: string
  mimeType?: string
  template?: boolean
}

export interface McpPromptSummary {
  server: string
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

export interface McpToolSummary {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export interface McpServerCatalog {
  server: string
  tools: McpToolSummary[]
  resources: McpResourceSummary[]
  prompts: McpPromptSummary[]
  updatedAt?: string
  stale: boolean
}
