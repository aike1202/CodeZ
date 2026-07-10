import type { ChatProviderErrorCode } from '../../../shared/types/provider'

export function classifyProviderError(status: number, body: string): ChatProviderErrorCode {
  const normalized = body.toLowerCase()
  if (
    /context[_ -]length[_ -]exceeded|maximum context length|context window|too many tokens|input.*tokens.*limit/.test(normalized)
  ) return 'CONTEXT_OVERFLOW'
  if (status === 401 || status === 403) return 'AUTHENTICATION'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 404) return 'NOT_FOUND'
  return 'UNKNOWN'
}
