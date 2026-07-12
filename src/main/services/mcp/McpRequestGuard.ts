export interface McpRequestGuardOptions {
  failureThreshold?: number
  cooldownMs?: number
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

function statusCode(error: any): number | undefined {
  const direct = Number(error?.code ?? error?.status ?? error?.response?.status)
  if (Number.isInteger(direct) && direct >= 100 && direct <= 599) return direct
  const match = String(error?.message || '').match(/(?:HTTP|status)\s*(429|5\d\d)/i)
  return match ? Number(match[1]) : undefined
}

function retryAfterMs(error: any, now: number): number | undefined {
  if (Number.isFinite(error?.retryAfterMs)) return Math.max(0, Number(error.retryAfterMs))
  const raw = error?.response?.headers?.get?.('retry-after') ?? error?.headers?.get?.('retry-after')
  if (typeof raw !== 'string') return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(raw)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

function retryable(error: unknown): boolean {
  const status = statusCode(error)
  if (status === 429 || (status !== undefined && status >= 500)) return true
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|temporar/i.test(String((error as any)?.message || error))
}

export class McpRequestGuard {
  private consecutiveFailures = 0
  private openUntil = 0
  private readonly options: Required<McpRequestGuardOptions>

  constructor(
    options: McpRequestGuardOptions = {},
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random
  ) {
    this.options = {
      failureThreshold: options.failureThreshold || 5,
      cooldownMs: options.cooldownMs || 30_000,
      maxAttempts: options.maxAttempts || 3,
      baseDelayMs: options.baseDelayMs || 250,
      maxDelayMs: options.maxDelayMs || 5_000
    }
  }

  async run<T>(operation: () => Promise<T>, options: { idempotent: boolean } = { idempotent: true }): Promise<T> {
    const now = this.now()
    if (this.openUntil > now) {
      throw Object.assign(new Error('MCP server circuit breaker is open.'), {
        code: 'MCP_CIRCUIT_OPEN',
        retryAfterMs: this.openUntil - now
      })
    }
    const attempts = options.idempotent ? this.options.maxAttempts : 1
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const result = await operation()
        this.consecutiveFailures = 0
        this.openUntil = 0
        return result
      } catch (error) {
        lastError = error
        if (!retryable(error) || attempt + 1 >= attempts) break
        const serverDelay = retryAfterMs(error, this.now())
        const exponential = Math.min(this.options.maxDelayMs, this.options.baseDelayMs * 2 ** attempt)
        const delay = Math.min(this.options.maxDelayMs, serverDelay ?? Math.round(exponential * (0.75 + this.random() * 0.5)))
        await this.sleep(delay)
      }
    }
    if (retryable(lastError)) {
      this.consecutiveFailures++
      if (this.consecutiveFailures >= this.options.failureThreshold) {
        this.openUntil = this.now() + this.options.cooldownMs
      }
    }
    throw lastError
  }
}
