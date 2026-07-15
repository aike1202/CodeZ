import { describe, expect, it, vi } from 'vitest'
import {
  decorateApprovalSchema,
  extractToolApproval
} from '../main/tools/runtime/ToolApprovalPolicy'
import { ToolRegistry } from '../main/tools/runtime/ToolRegistry'
import type { ToolHandler } from '../main/tools/runtime/types'

describe('tool approval policy', () => {
  it('decorates effectful schemas without mutating the original', () => {
    const schema = {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false
    }
    const decorated = decorateApprovalSchema(schema, { modelPreference: 'required' })

    expect(schema).toEqual({
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false
    })
    expect(decorated).toMatchObject({
      properties: { approval: { type: 'string', enum: ['auto', 'user'] } },
      required: ['command', 'approval']
    })
  })

  it('leaves read-only schemas unchanged but reserves the approval property', () => {
    const schema = { type: 'object', properties: { path: { type: 'string' } } }
    expect(decorateApprovalSchema(schema, { modelPreference: 'not-applicable' })).toBe(schema)
    expect(() => decorateApprovalSchema({
      type: 'object',
      properties: { approval: { type: 'boolean' } }
    }, { modelPreference: 'not-applicable' })).toThrow(/reserved CodeZ property/)
  })

  it('extracts approval metadata without exposing it as business input', () => {
    expect(extractToolApproval(
      { command: 'npm test', approval: 'auto' },
      { modelPreference: 'required' }
    )).toEqual({
      approvalPreference: 'auto',
      businessInput: { command: 'npm test' }
    })
  })

  it('decorates handlers at the registry boundary', () => {
    const handler = {
      descriptor: {
        name: 'Effectful', aliases: [], version: '1', source: 'plugin', sourceId: 'test',
        summary: 'effectful', description: 'effectful',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        approval: { modelPreference: 'required' },
        availability: { enabled: () => true, roles: '*', exposure: 'core' },
        behavior: { readOnly: () => false, destructive: () => false, concurrency: 'safe', interrupt: 'cancel', maxResultChars: 1000 },
        planEffects: async () => ({ effects: [{ kind: 'unknown', target: 'test' }], analysisStatus: 'unparsed' }),
        resourceKeys: async () => []
      },
      execute: vi.fn(async () => ({ status: 'success' as const, modelContent: 'ok' }))
    } as ToolHandler<Record<string, unknown>>

    const registry = new ToolRegistry()
    registry.register(handler)
    const registered = registry.resolve('Effectful')
    expect(registered?.descriptor.inputSchema).toMatchObject({
      properties: { approval: { enum: ['auto', 'user'] } },
      required: ['approval']
    })
    expect(registered?.descriptor.version).not.toBe('1')
  })

  it('treats legacy dynamic handlers without metadata as effectful', () => {
    const registry = new ToolRegistry()
    registry.register({
      descriptor: {
        name: 'LegacyPlugin', aliases: [], version: '1', source: 'plugin', sourceId: 'legacy',
        summary: 'legacy', description: 'legacy',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        availability: { enabled: () => true, roles: '*', exposure: 'core' },
        behavior: { readOnly: () => false, destructive: () => false, concurrency: 'safe', interrupt: 'cancel', maxResultChars: 1000 },
        planEffects: async () => ({ effects: [{ kind: 'unknown', target: 'legacy' }], analysisStatus: 'unparsed' }),
        resourceKeys: async () => []
      },
      execute: async () => ({ status: 'success', modelContent: 'ok' })
    } as any)

    expect(registry.resolve('LegacyPlugin')?.descriptor).toMatchObject({
      approval: { modelPreference: 'required' },
      inputSchema: { required: ['approval'] }
    })
  })
})
