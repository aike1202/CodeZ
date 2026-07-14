import { describe, expect, it } from 'vitest'
import {
  parseUserConfiguration,
  serializeUserConfiguration
} from '../renderer/src/components/SettingsMcpTab/utils'

describe('MCP settings JSON helpers', () => {
  it('accepts mcpServers, servers, and direct server maps', () => {
    const server = { type: 'stdio' as const, command: 'npx', args: ['-y', 'example'] }
    expect(parseUserConfiguration(JSON.stringify({ mcpServers: { first: server } }))).toEqual({ first: server })
    expect(parseUserConfiguration(JSON.stringify({ servers: { second: server } }))).toEqual({ second: server })
    expect(parseUserConfiguration(JSON.stringify({ third: server }))).toEqual({ third: server })
  })

  it('rejects non-object server entries with the server name in the error', () => {
    expect(() => parseUserConfiguration('{"mcpServers":{"broken":true}}')).toThrow(/broken/)
  })

  it('serializes only user-scope configs into the canonical wrapper', () => {
    const json = serializeUserConfiguration([
      {
        name: 'user-server', scope: 'user', config: { type: 'http', url: 'https://example.test/mcp' },
        fingerprint: 'one', trusted: true, effective: true
      },
      {
        name: 'project-server', scope: 'project', config: { type: 'stdio', command: 'node' },
        fingerprint: 'two', trusted: true, effective: true
      }
    ])
    expect(JSON.parse(json)).toEqual({
      mcpServers: { 'user-server': { type: 'http', url: 'https://example.test/mcp' } }
    })
  })
})
