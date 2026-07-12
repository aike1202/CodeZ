import { describe, expect, it, vi } from 'vitest'
import { McpRequestGuard } from '../main/services/mcp/McpRequestGuard'

describe('McpRequestGuard', () => {
  it('retries idempotent 429 responses using Retry-After', async () => {
    const delays: number[] = []
    let attempts = 0
    const guard = new McpRequestGuard(
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 5000 },
      async (delay) => { delays.push(delay) },
      () => 1000,
      () => 0
    )
    const result = await guard.run(async () => {
      attempts++
      if (attempts < 3) {
        throw Object.assign(new Error('HTTP 429'), {
          code: 429,
          response: { headers: new Headers({ 'Retry-After': '2' }) }
        })
      }
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(attempts).toBe(3)
    expect(delays).toEqual([2000, 2000])
  })

  it('never retries a non-idempotent mutation', async () => {
    const operation = vi.fn(async () => { throw Object.assign(new Error('HTTP 503'), { code: 503 }) })
    const guard = new McpRequestGuard({}, vi.fn(async () => undefined))
    await expect(guard.run(operation, { idempotent: false })).rejects.toThrow(/503/)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('opens and later recovers a server-scoped circuit breaker', async () => {
    let now = 1000
    const guard = new McpRequestGuard(
      { failureThreshold: 2, cooldownMs: 500, maxAttempts: 1 },
      vi.fn(async () => undefined),
      () => now
    )
    const fail = () => Promise.reject(Object.assign(new Error('HTTP 503'), { code: 503 }))
    await expect(guard.run(fail)).rejects.toThrow(/503/)
    await expect(guard.run(fail)).rejects.toThrow(/503/)
    await expect(guard.run(async () => 'blocked')).rejects.toMatchObject({ code: 'MCP_CIRCUIT_OPEN', retryAfterMs: 500 })
    now += 501
    await expect(guard.run(async () => 'recovered')).resolves.toBe('recovered')
  })
})
