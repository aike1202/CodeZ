import type { CommandError, ErrorCode } from './generated/contracts'

const ERROR_CODES = new Set<ErrorCode>([
  'VALIDATION',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'CONFLICT',
  'EXTERNAL',
  'CANCELLED',
  'TIMEOUT',
  'STORAGE',
  'INTERNAL'
])

function isCommandError(value: unknown): value is CommandError {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.code === 'string' &&
    ERROR_CODES.has(candidate.code as ErrorCode) &&
    typeof candidate.message === 'string' &&
    typeof candidate.retryable === 'boolean'
}

export class DesktopCommandError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly correlationId: string | null

  constructor(error: CommandError) {
    super(error.message)
    this.name = 'DesktopCommandError'
    this.code = error.code
    this.retryable = error.retryable
    this.correlationId = error.correlationId
  }
}

export function normalizeDesktopError(value: unknown): DesktopCommandError {
  if (value instanceof DesktopCommandError) return value
  if (isCommandError(value)) return new DesktopCommandError(value)
  if (value instanceof Error) {
    return new DesktopCommandError({
      code: 'INTERNAL',
      message: value.message,
      retryable: false,
      correlationId: null
    })
  }
  return new DesktopCommandError({
    code: 'INTERNAL',
    message: 'Desktop command failed',
    retryable: false,
    correlationId: null
  })
}
