import { describe, expect, it } from 'vitest'
import { Tool, type ToolContext } from '../main/tools/Tool'
import { LegacyToolAdapter } from '../main/tools/runtime/LegacyToolAdapter'
import { ToolResultProcessor } from '../main/tools/runtime/ToolResultProcessor'
import type { ToolPipelineResult } from '../main/tools/runtime/types'

class SuccessEnvelopeTool extends Tool {
  get name() { return 'SuccessEnvelope' }
  get summary() { return 'Return a legacy success envelope' }
  get description() { return 'Test-only legacy tool.' }
  get parameters_schema() { return { type: 'object', properties: {} } }

  async execute(_args: string, _context: ToolContext): Promise<string> {
    return JSON.stringify({ ok: true, summary: 'state saved' })
  }
}

describe('LegacyToolAdapter', () => {
  it('keeps a valid model result when a success envelope has no data field', async () => {
    const result = await new LegacyToolAdapter(new SuccessEnvelopeTool()).execute(
      {},
      { workspaceRoot: 'C:\\workspace' }
    )

    expect(result.status).toBe('success')
    expect(result.status === 'success' && result.modelContent).toContain('state saved')
  })
})

describe('ToolResultProcessor', () => {
  it('does not crash when a runtime handler violates the success content contract', async () => {
    const malformed = {
      call: { callId: 'call-1', position: 0, name: 'Malformed', rawArguments: '{}' },
      canonicalName: 'Malformed',
      result: { status: 'success', data: { saved: true }, modelContent: undefined }
    } as unknown as ToolPipelineResult

    const [result] = await new ToolResultProcessor(undefined, undefined, false).processBatch(
      [malformed],
      { workspaceRoot: 'C:\\workspace', sessionId: 'session-1' }
    )

    expect(result.result.status).toBe('success')
    expect(result.result.status === 'success' && result.result.modelContent).toBe('{"saved":true}')
  })
})
