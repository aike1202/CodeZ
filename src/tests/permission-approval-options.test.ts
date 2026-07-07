import { describe, expect, it } from 'vitest'
import {
  generateCommandRuleOptions,
  PERMISSION_SCOPE_OPTIONS
} from '../renderer/src/components/chat/permissionApprovalOptions'

describe('permission approval command options', () => {
  it('keeps frontend fallback command rules exact and separates approval scope choices', () => {
    expect(generateCommandRuleOptions('Get-ChildItem -Force | Format-Table')).toEqual([
      {
        id: 'exact',
        label: '仅此完整命令',
        rule: 'Get-ChildItem -Force | Format-Table',
        description: '只允许当前这条完整命令。'
      }
    ])

    expect(PERMISSION_SCOPE_OPTIONS).toEqual([
      { id: 'once', label: '仅此次允许执行' },
      { id: 'session', label: '允许本会话使用' },
      { id: 'workspace', label: '始终允许本项目使用' }
    ])
  })
})
