import { describe, expect, it } from 'vitest'
import { approvalOptionsForRequest } from '../renderer/src/components/chat/permissionApprovalOptions'

describe('permission approval options', () => {
  it('offers remembered scopes for L2/L3', () => {
    expect(approvalOptionsForRequest({ riskLevel: 2, allowedScopes: ['once', 'session', 'workspace'] } as any).map((item) => item.scope)).toEqual(['once', 'session', 'workspace'])
  })

  it('offers only once for L4', () => {
    expect(approvalOptionsForRequest({ riskLevel: 4, allowedScopes: ['once'] } as any).map((item) => item.scope)).toEqual(['once'])
  })
})
