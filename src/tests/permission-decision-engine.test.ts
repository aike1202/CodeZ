import { describe, expect, it } from 'vitest'
import type { PermissionCapability, PermissionCheck } from '../shared/types/permission'
import { PermissionDecisionEngine } from '../main/services/permission/PermissionDecisionEngine'

describe('PermissionDecisionEngine', () => {
  const engine = new PermissionDecisionEngine()

  it.each([
    ['read', 'allow'],
    ['edit', 'allow'],
    ['shell', 'allow'],
    ['network', 'ask'],
    ['external_effect', 'ask'],
    ['external_directory', 'ask'],
    ['delete', 'ask'],
    ['rollback', 'ask'],
    ['shell_unparsed', 'ask'],
    ['unknown', 'ask']
  ] as const)('uses the auto default for %s', (permission, action) => {
    expect(engine.decide({ mode: 'auto', permission }).action).toBe(action)
  })

  it('allows normal capabilities in full-access mode', () => {
    const permissions: PermissionCapability[] = ['shell', 'network', 'delete', 'shell_unparsed', 'unknown']
    for (const permission of permissions) {
      expect(engine.decide({ mode: 'full-access', permission }).action).toBe('allow')
    }
  })

  it('applies explicit rules before mode defaults', () => {
    expect(engine.decide({ mode: 'full-access', permission: 'shell', explicitRule: 'deny' }).action).toBe('deny')
    expect(engine.decide({ mode: 'auto', permission: 'network', explicitRule: 'allow' }).action).toBe('allow')
  })

  it('lets the model request approval without letting auto weaken auto mode', () => {
    expect(engine.decide({
      mode: 'full-access', permission: 'shell', approvalPreference: 'user'
    }).action).toBe('ask')
    expect(engine.decide({
      mode: 'auto', permission: 'network', approvalPreference: 'auto'
    }).action).toBe('ask')
    expect(engine.decide({
      mode: 'full-access', permission: 'network', approvalPreference: 'auto'
    }).action).toBe('allow')
  })

  it('keeps deny and absolute redlines above the model preference', () => {
    expect(engine.decide({
      mode: 'full-access', permission: 'shell', explicitRule: 'deny', approvalPreference: 'user'
    }).action).toBe('deny')
    expect(engine.decide({
      mode: 'full-access', permission: 'shell', absoluteRedline: true, approvalPreference: 'auto'
    }).action).toBe('ask')
  })

  it('does not let an explicit allow bypass Hardline', () => {
    expect(engine.decide({ mode: 'full-access', permission: 'hardline', explicitRule: 'allow' }).action).toBe('ask')
  })

  it('aggregates deny before ask before allow', () => {
    const check = (action: PermissionCheck['action']): PermissionCheck => ({ permission: 'shell', pattern: 'x', action, reason: 'test' })
    expect(engine.aggregate([check('allow'), check('ask')])).toBe('ask')
    expect(engine.aggregate([check('allow'), check('ask'), check('deny')])).toBe('deny')
    expect(engine.aggregate([check('allow')])).toBe('allow')
  })
})
