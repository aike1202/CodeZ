import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatProviderFactory } from '../main/services/chat/ChatProviderFactory'
import { McpRequestGuard } from '../main/services/mcp/McpRequestGuard'
import { ToolManager } from '../main/tools/ToolManager'
import { McpToolHandler } from '../main/tools/mcp/McpToolHandler'

afterEach(() => { vi.unstubAllGlobals() })

const responses = {
  openai: ['data: {"choices":[]}', 'data: [DONE]', ''].join('\n'),
  anthropic: [
    'event: message_delta',
    'data: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
    '',
    'event: message_stop',
    'data: {}',
    ''
  ].join('\n'),
  gemini: ['data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}', 'data: [DONE]', ''].join('\n')
}

describe('MCP provider payloads', () => {
  for (const apiFormat of ['openai', 'anthropic', 'gemini'] as const) {
    it(`exposes ToolSearch and an activated MCP tool to ${apiFormat}`, async () => {
      let requestBody: any
      vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body || '{}'))
        return new Response(responses[apiFormat], {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      }))

      const manager = new ToolManager()
      const mcpHandler = new McpToolHandler(
        'payload',
        'payload-identity',
        {
          name: 'review.issue',
          description: 'Review one issue from the MCP server',
          inputSchema: {
            type: 'object',
            properties: { issue: { type: 'string' } },
            required: ['issue'],
            additionalProperties: false
          }
        },
        { callTool: vi.fn() } as any,
        new McpRequestGuard({ maxAttempts: 1 })
      )
      manager.registerHandler(mcpHandler)
      try {
        const plan = manager.createExposurePlan({
          activatedDeferredTools: new Set([mcpHandler.descriptor.name])
        })
        const tools = manager.getToolDefinitionsForExposure(plan)
        expect(tools.map((tool) => tool.function.name)).toEqual(expect.arrayContaining([
          'ToolSearch', 'mcp__payload__review_issue'
        ]))

        const provider = ChatProviderFactory.createProvider({
          baseUrl: 'https://provider.example/v1',
          apiKey: 'key',
          model: 'model',
          apiFormat,
          messages: [{ role: 'user', content: 'review the issue' }],
          tools
        })
        await provider.streamChat({
          baseUrl: 'https://provider.example/v1',
          apiKey: 'key',
          model: 'model',
          apiFormat,
          messages: [{ role: 'user', content: 'review the issue' }],
          tools
        }, {
          onChunk: () => undefined,
          onDone: () => undefined,
          onError: (error) => { throw new Error(error) }
        }, new AbortController().signal)

        const declarations = apiFormat === 'openai'
          ? requestBody.tools.map((tool: any) => ({
              name: tool.function.name,
              description: tool.function.description,
              schema: tool.function.parameters
            }))
          : apiFormat === 'anthropic'
            ? requestBody.tools.map((tool: any) => ({
                name: tool.name,
                description: tool.description,
                schema: tool.input_schema
              }))
            : requestBody.tools[0].functionDeclarations.map((tool: any) => ({
                name: tool.name,
                description: tool.description,
                schema: tool.parameters
              }))
        expect(declarations).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: 'ToolSearch' }),
          {
            name: 'mcp__payload__review_issue',
            description: expect.stringContaining('Review one issue'),
            schema: expect.objectContaining({
              type: 'object',
              required: ['issue']
            })
          }
        ]))
      } finally {
        manager.unregisterSource('mcp:payload')
      }
    })
  }
})
