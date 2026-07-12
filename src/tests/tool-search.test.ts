import { describe, expect, it } from 'vitest'
import { ToolSearchTool } from '../main/tools/builtin/ToolSearchTool'
import { LegacyToolAdapter } from '../main/tools/runtime/LegacyToolAdapter'

const deferred = [
  { name: 'WebSearch', summary: 'Search current web information', searchHint: 'internet documentation' },
  { name: 'mcp__github__create_issue', summary: 'Create a GitHub issue', searchHint: 'repository ticket' },
  { name: 'NotebookEdit', summary: 'Edit a notebook cell' }
]

describe('ToolSearchTool', () => {
  it('activates a directly selected tool for the next turn', async () => {
    const activated: string[] = []
    const output = await new ToolSearchTool().execute('{"query":"select:WebSearch"}', {
      workspaceRoot: 'C:\\workspace',
      toolExposure: { deferredTools: deferred, activate: (names) => activated.push(...names) }
    })
    expect(activated).toEqual(['WebSearch'])
    expect(JSON.parse(output).data.availableNextTurn).toBe(true)
  })

  it('searches MCP names, summaries, and hints', async () => {
    const activated: string[] = []
    await new ToolSearchTool().execute('{"query":"github issue"}', {
      workspaceRoot: 'C:\\workspace',
      toolExposure: { deferredTools: deferred, activate: (names) => activated.push(...names) }
    })
    expect(activated).toEqual(['mcp__github__create_issue'])
  })

  it('uses the native typed-result hook through the compatibility adapter', async () => {
    const handler = new LegacyToolAdapter(new ToolSearchTool())
    const result = await handler.execute({ query: 'select:WebSearch' }, {
      workspaceRoot: 'C:\\workspace',
      toolExposure: { deferredTools: deferred, activate: () => undefined }
    })
    expect(result).toMatchObject({
      status: 'success', data: { activated: ['WebSearch'], availableNextTurn: true }
    })
    expect(result.status === 'success' && result.modelContent).not.toContain('"ok":true')
  })
})
