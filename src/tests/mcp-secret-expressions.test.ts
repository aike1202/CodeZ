import { afterEach, describe, expect, it } from 'vitest'
import { resolveMcpSecretExpressions, type McpSecretResolver } from '../main/services/mcp/McpSecretStore'

const originalEnvironment = process.env.CODEZ_MCP_TEST_TOKEN

afterEach(() => {
  if (originalEnvironment === undefined) delete process.env.CODEZ_MCP_TEST_TOKEN
  else process.env.CODEZ_MCP_TEST_TOKEN = originalEnvironment
})

describe('MCP secret expressions', () => {
  it('resolves environment and secure-store references without exposing unrelated values', async () => {
    process.env.CODEZ_MCP_TEST_TOKEN = 'environment-value'
    const resolver: McpSecretResolver = {
      resolve: async (key) => key === 'github.token' ? 'secure-value' : undefined
    }
    const observed: string[] = []

    await expect(resolveMcpSecretExpressions(
      'env=${env:CODEZ_MCP_TEST_TOKEN}; secret=${secret:github.token}',
      resolver,
      (value) => observed.push(value)
    )).resolves.toBe('env=environment-value; secret=secure-value')
    expect(observed).toEqual(['environment-value', 'secure-value'])
  })

  it('rejects missing and malformed references without including secret values', async () => {
    const resolver: McpSecretResolver = { resolve: async () => undefined }
    await expect(resolveMcpSecretExpressions('${secret:missing}', resolver)).rejects.toThrow("secret 'missing' is not configured")
    await expect(resolveMcpSecretExpressions('${env:bad-name}', resolver)).rejects.toThrow(/Invalid MCP environment/)
  })
})
