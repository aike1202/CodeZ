import type { CommandError, ErrorCode } from './generated/contracts'

const ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  'VALIDATION',
  'UNSUPPORTED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'CONFLICT',
  'RUN_ACTIVE',
  'HISTORY_REVERT_STALE',
  'RECOVERY_REQUIRED',
  'EXTERNAL',
  'PROCESS_FAILED',
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
    typeof candidate.retryable === 'boolean' &&
    (candidate.correlationId === null || typeof candidate.correlationId === 'string')
}

function parseCommandError(value: unknown): CommandError | null {
  if (isCommandError(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isCommandError(parsed) ? parsed : null
  } catch {
    return null
  }
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
  const commandError = parseCommandError(value)
  if (commandError) return new DesktopCommandError(commandError)
  return new DesktopCommandError({
    code: 'INTERNAL',
    message: 'Desktop command failed',
    retryable: false,
    correlationId: null
  })
}
