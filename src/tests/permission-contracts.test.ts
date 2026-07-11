import { describe, expect, it } from 'vitest'
import { allowedScopesForDecision, allowedScopesForRisk, DEFAULT_PERMISSION_MODE } from '../shared/types/permission'

describe('permission contracts', () => {
  it('defaults new workspaces to auto mode', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('auto')
  })

  it('never persists an L4 approval', () => {
    expect(allowedScopesForRisk(4)).toEqual(['once'])
    expect(allowedScopesForRisk(3)).toEqual(['once', 'session', 'workspace'])
  })

  it('bases approval scopes on Hardline instead of compatibility risk metadata', () => {
    expect(allowedScopesForDecision(true)).toEqual(['once'])
    expect(allowedScopesForDecision(false)).toEqual(['once', 'session', 'workspace'])
  })
})
