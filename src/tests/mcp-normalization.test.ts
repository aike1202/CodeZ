import { describe, expect, it } from 'vitest'
import { mcpToolName, normalizeMcpName } from '../main/services/mcp/normalization'

describe('MCP tool name normalization', () => {
  it('keeps Claude Code compatible names for ordinary tools', () => {
    expect(mcpToolName('server name', 'tool.name')).toBe('mcp__server_name__tool_name')
    expect(normalizeMcpName('  server...name  ')).toBe('server_name')
  })

  it('uses stable distinct hashes when provider-safe names exceed 64 characters', () => {
    const first = mcpToolName('long-server-name', `read_${'a'.repeat(80)}_one`)
    const second = mcpToolName('long-server-name', `read_${'a'.repeat(80)}_two`)
    expect(first).toHaveLength(64)
    expect(second).toHaveLength(64)
    expect(first).not.toBe(second)
    expect(mcpToolName('long-server-name', `read_${'a'.repeat(80)}_one`)).toBe(first)
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})
