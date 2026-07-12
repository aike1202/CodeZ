export type EnforcementMode = 'off' | 'shadow' | 'enforce'

function booleanFlag(name: string, defaultValue: boolean): boolean {
  const value = process.env[name]
  if (value === undefined) return defaultValue
  return !['0', 'false', 'off'].includes(value.toLowerCase())
}

function enforcementFlag(name: string, defaultValue: EnforcementMode): EnforcementMode {
  const value = process.env[name]?.toLowerCase()
  return value === '0' || value === 'off'
    ? 'off'
    : value === 'shadow' ? 'shadow' : value === 'enforce' ? 'enforce' : defaultValue
}

export interface ToolRuntimeFeatureFlags {
  runtimeV2: boolean
  effectPolicy: EnforcementMode
  scheduler: EnforcementMode
  toolSearch: boolean
  resultStore: boolean
  hooks: 'off' | 'internal' | 'configured'
}

export function getToolRuntimeFeatureFlags(): ToolRuntimeFeatureFlags {
  const hooks = process.env.CODEZ_TOOL_HOOKS?.toLowerCase()
  return {
    runtimeV2: booleanFlag('CODEZ_TOOL_RUNTIME_V2', true),
    effectPolicy: enforcementFlag('CODEZ_TOOL_EFFECT_POLICY', 'enforce'),
    scheduler: enforcementFlag('CODEZ_TOOL_SCHEDULER', 'enforce'),
    toolSearch: booleanFlag('CODEZ_TOOL_SEARCH', true),
    resultStore: booleanFlag('CODEZ_TOOL_RESULT_STORE', true),
    hooks: hooks === 'off' || hooks === 'configured' ? hooks : 'internal'
  }
}
