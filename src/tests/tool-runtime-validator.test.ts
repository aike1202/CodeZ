import { describe, expect, it } from 'vitest'
import { Tool, type ToolContext } from '../main/tools/Tool'
import { ToolRegistry } from '../main/tools/runtime/ToolRegistry'
import { ToolInputValidator } from '../main/tools/runtime/ToolInputValidator'

class ValidatedTool extends Tool {
  get name() { return 'Validated' }
  get summary() { return 'Validate input' }
  get description() { return 'Validates input.' }
  get parameters_schema() {
    return {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false
    }
  }
  async execute(_args: string, _context: ToolContext) { return 'ok' }
}

describe('ToolInputValidator', () => {
  const registry = new ToolRegistry()
  registry.registerLegacy(new ValidatedTool())
  const snapshot = registry.createSnapshot({ platform: process.platform, agentRole: 'main' })

  it('returns parsed validated input', () => {
    const result = new ToolInputValidator().validate(snapshot, 'Validated', '{"value":"ok"}')
    expect(result).toEqual({ ok: true, input: { value: 'ok' } })
  })

  it('reports missing and unexpected parameters', () => {
    const result = new ToolInputValidator().validate(snapshot, 'Validated', '{"extra":true}')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('TOOL_INPUT_INVALID')
      expect(result.error.issues?.join('\n')).toContain('value')
      expect(result.error.issues?.join('\n')).toContain('extra')
    }
  })

  it('rejects malformed and oversized JSON', () => {
    const validator = new ToolInputValidator(8)
    expect(validator.validate(snapshot, 'Validated', '{').ok).toBe(false)
    const large = validator.validate(snapshot, 'Validated', '{"value":"too-large"}')
    expect(large.ok).toBe(false)
    if (!large.ok) expect(large.error.code).toBe('TOOL_ARGUMENTS_TOO_LARGE')
  })
})

