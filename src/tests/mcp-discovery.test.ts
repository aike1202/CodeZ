import { describe, expect, it } from 'vitest'
import type { Tool as McpSdkTool } from '@modelcontextprotocol/sdk/types.js'
import {
  collectMcpPages,
  isolateMcpPrompts,
  isolateMcpResources,
  isolateMcpTools
} from '../main/services/mcp/discovery'

describe('MCP capability discovery', () => {
  it('collects bounded pages and rejects cursor loops', async () => {
    await expect(collectMcpPages<{ id: number }>(async (cursor) => cursor
      ? { tools: [{ id: 2 }] }
      : { tools: [{ id: 1 }], nextCursor: 'next' }, 'tools'))
      .resolves.toEqual([{ id: 1 }, { id: 2 }])

    await expect(collectMcpPages(async () => ({ tools: [], nextCursor: 'same' }), 'tools'))
      .rejects.toThrow(/cursor loop/)
    await expect(collectMcpPages(async () => ({ tools: [{}, {}] }), 'tools', {
      maxPages: 2, maxItems: 1, maxSchemaBytes: 100, maxDescriptionChars: 100
    })).rejects.toThrow(/item limit/)
  })

  it('isolates one malformed schema and normalized-name conflicts', () => {
    const tools: McpSdkTool[] = [
      { name: 'valid', description: 'ok', inputSchema: { type: 'object', properties: {} } },
      { name: 'bad-schema', inputSchema: { type: 'not-a-json-schema-type' } as any },
      { name: 'same.name', inputSchema: { type: 'object' } },
      { name: 'same name', inputSchema: { type: 'object' } },
      { name: 'bad-ref', inputSchema: { type: 'object', properties: { value: { $ref: '#/$defs/missing' } } } }
    ]

    const result = isolateMcpTools('server', tools)
    expect(result.tools.map((tool) => tool.name)).toEqual(['valid', 'same.name'])
    expect(result.rejected).toEqual(expect.arrayContaining([
      { toolName: 'bad-schema', reason: 'invalid-input-schema' },
      { toolName: 'same name', reason: 'normalized-name-conflict' },
      { toolName: 'bad-ref', reason: 'invalid-input-schema' }
    ]))
  })

  it('keeps distinct long tool names after provider-safe normalization', () => {
    const prefix = 'read_'.padEnd(90, 'a')
    const result = isolateMcpTools('server', [
      { name: `${prefix}_one`, inputSchema: { type: 'object' } },
      { name: `${prefix}_two`, inputSchema: { type: 'object' } }
    ])
    expect(result.tools).toHaveLength(2)
    expect(result.rejected).toEqual([])
  })

  it('isolates invalid and duplicate resources, templates, and prompts', () => {
    const resources = isolateMcpResources([
      { uri: 'test://one', name: 'one' },
      { uri: 'test://one', name: 'duplicate' },
      { uri: 'bad\nuri', name: 'bad' }
    ], [
      { uriTemplate: 'test://items/{id}', name: 'items' },
      { uriTemplate: 'test://items/{id}', name: 'duplicate-template' },
      { uriTemplate: '{', name: 'invalid-template' }
    ])
    expect(resources.resources.map((resource) => resource.name)).toEqual(['one'])
    expect(resources.templates.map((template) => template.name)).toEqual(['items'])
    expect(resources.rejected.map((item) => item.reason)).toEqual([
      'duplicate-uri', 'invalid-resource', 'duplicate-uri', 'invalid-template'
    ])

    const prompts = isolateMcpPrompts([
      { name: 'review' }, { name: 'review' }, { name: 'bad\nname' }
    ])
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(['review'])
    expect(prompts.rejected.map((item) => item.reason)).toEqual(['duplicate-name', 'invalid-prompt'])
  })
})
