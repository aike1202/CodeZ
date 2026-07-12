import { createHash } from 'crypto'
import type { ChatMessage, ThinkingConfig } from '../../../shared/types/provider'

export interface ProviderUsageRequestProfile {
  providerId?: string
  model?: string
  apiFormat?: string
  baseUrl?: string
  thinking?: ThinkingConfig
  maxOutputTokens?: number
  reasoningBudgetTokens?: number
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (Array.isArray(value)) {
    return `[${value.map((entry) =>
      entry === undefined || typeof entry === 'function' || typeof entry === 'symbol'
        ? 'null'
        : canonicalJson(entry)
    ).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .filter((key) => {
        const entry = record[key]
        return entry !== undefined && typeof entry !== 'function' && typeof entry !== 'symbol'
      })
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return 'null'
}

/** Binds Provider usage to the exact request whose input tokens were measured. */
export function fingerprintProviderRequest(input: {
  messages: readonly ChatMessage[]
  toolSchemas: readonly unknown[]
  profile?: ProviderUsageRequestProfile
}): string {
  const payload = canonicalJson({
    version: 1,
    adapter: 'provider-message-adapter-v1',
    messages: input.messages,
    toolSchemas: input.toolSchemas,
    profile: input.profile || {}
  })
  return createHash('sha256')
    .update('codez-provider-usage-request-v1\n')
    .update(payload)
    .digest('hex')
}
