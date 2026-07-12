import { describe, expect, it } from 'vitest'
import { Tool, type ToolContext } from '../main/tools/Tool'
import { ToolRegistry } from '../main/tools/runtime/ToolRegistry'

class TestTool extends Tool {
  constructor(private readonly toolName: string) { super() }
  get name() { return this.toolName }
  get summary() { return 'Test tool' }
  get description() { return 'A test tool.' }
  get parameters_schema() {
    return {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false
    }
  }
  async execute(args: string, _context: ToolContext) { return args }
}

describe('ToolRegistry', () => {
  it('creates a stable catalog fingerprint for equivalent registries', () => {
    const first = new ToolRegistry()
    const second = new ToolRegistry()
    first.registerLegacy(new TestTool('Alpha'))
    second.registerLegacy(new TestTool('Alpha'))
    const context = { platform: process.platform, agentRole: 'main' }
    expect(first.createSnapshot(context).fingerprint).toBe(second.createSnapshot(context).fingerprint)
  })

  it('rejects canonical name conflicts', () => {
    const registry = new ToolRegistry()
    registry.registerLegacy(new TestTool('Alpha'))
    expect(() => registry.registerLegacy(new TestTool('Alpha'))).toThrow(/already registered/)
  })

  it('removes every handler from a source', () => {
    const registry = new ToolRegistry()
    registry.registerLegacy(new TestTool('Alpha'))
    registry.unregisterSource('codez:builtins')
    expect(registry.resolve('Alpha')).toBeUndefined()
  })
})

