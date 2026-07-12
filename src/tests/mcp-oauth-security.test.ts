import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: vi.fn(async () => undefined) }
}))

import { McpOAuthProvider, withMcpOAuthLock } from '../main/services/mcp/McpOAuthProvider'

describe('MCP OAuth security controls', () => {
  it('fails closed instead of persisting tokens without OS encryption', async () => {
    const provider = new McpOAuthProvider(
      'no-secure-storage', 'test', { type: 'http', url: 'https://example.test/mcp' }
    )
    await expect(provider.saveTokens({ access_token: 'secret', token_type: 'bearer' }))
      .rejects.toThrow(/Secure operating-system storage is unavailable/)
    expect(await provider.tokens()).toBeUndefined()
  })

  it('serializes OAuth work per server identity while allowing other identities', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = withMcpOAuthLock('same', async () => { order.push('first-start'); await gate; order.push('first-end') })
    const second = withMcpOAuthLock('same', async () => { order.push('second') })
    const other = withMcpOAuthLock('other', async () => { order.push('other') })
    await other
    expect(order).toEqual(['first-start', 'other'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'other', 'first-end', 'second'])
  })

  it('rejects mismatched callback state and closes timed-out callbacks', async () => {
    const provider = new McpOAuthProvider(
      'state-test', 'test', { type: 'http', url: 'https://example.test/mcp' }
    )
    await provider.prepareCallback()
    const rejectedCallback = provider.waitForAuthorizationCode(100).then(
      () => undefined,
      (error) => error as Error
    )
    const response = await fetch(`${provider.redirectUrl}?code=code&state=wrong-state`)
    expect(response.status).toBe(400)
    expect(await rejectedCallback).toMatchObject({ message: expect.stringMatching(/state\/code validation/) })

    const timeoutProvider = new McpOAuthProvider(
      'timeout-test', 'test', { type: 'http', url: 'https://example.test/mcp' }
    )
    await timeoutProvider.prepareCallback()
    await expect(timeoutProvider.waitForAuthorizationCode(10)).rejects.toThrow(/timed out/)

    const cancelledProvider = new McpOAuthProvider(
      'cancel-test', 'test', { type: 'http', url: 'https://example.test/mcp' }
    )
    await cancelledProvider.prepareCallback()
    const cancelled = cancelledProvider.waitForAuthorizationCode(100).then(
      () => undefined,
      (error) => error as Error
    )
    const cancelResponse = await fetch(
      `${cancelledProvider.redirectUrl}?error=access_denied&state=${encodeURIComponent(cancelledProvider.state())}`
    )
    expect(cancelResponse.status).toBe(400)
    expect(await cancelled).toMatchObject({ message: 'access_denied' })
  })
})
