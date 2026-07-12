import { afterEach, describe, expect, it } from 'vitest'
import { getToolRuntimeFeatureFlags } from '../main/tools/runtime/ToolRuntimeFeatureFlags'

const original = { ...process.env }
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
})

describe('Tool Runtime feature flags', () => {
  it('provides production-safe defaults and independent rollback controls', () => {
    delete process.env.CODEZ_TOOL_RUNTIME_V2
    delete process.env.CODEZ_TOOL_EFFECT_POLICY
    delete process.env.CODEZ_TOOL_SCHEDULER
    expect(getToolRuntimeFeatureFlags()).toMatchObject({
      runtimeV2: true,
      effectPolicy: 'enforce',
      scheduler: 'enforce',
      toolSearch: true,
      resultStore: true
    })

    process.env.CODEZ_TOOL_RUNTIME_V2 = '0'
    process.env.CODEZ_TOOL_EFFECT_POLICY = 'shadow'
    process.env.CODEZ_TOOL_SCHEDULER = 'off'
    process.env.CODEZ_TOOL_SEARCH = '0'
    process.env.CODEZ_TOOL_RESULT_STORE = '0'
    expect(getToolRuntimeFeatureFlags()).toMatchObject({
      runtimeV2: false,
      effectPolicy: 'shadow',
      scheduler: 'off',
      toolSearch: false,
      resultStore: false
    })
  })
})
