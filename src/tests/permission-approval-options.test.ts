import { describe, expect, it } from 'vitest'
import { approvalOptionsForRequest } from '../renderer/src/components/chat/permissionApprovalOptions'

describe('permission approval options', () => {
  it('offers remembered scopes for normal permission asks', () => {
    expect(approvalOptionsForRequest({ hardline: false, allowedScopes: ['once', 'session', 'workspace'] } as any).map((item) => item.scope)).toEqual(['once', 'session', 'workspace'])
  })

  it('offers only once for Hardline', () => {
    expect(approvalOptionsForRequest({ hardline: true, allowedScopes: ['once'] } as any).map((item) => item.scope)).toEqual(['once'])
  })

  it('keeps legacy L4 requests once-only', () => {
    expect(approvalOptionsForRequest({ riskLevel: 4, allowedScopes: ['once'] } as any).map((item) => item.scope)).toEqual(['once'])
  })

  it('does not use L4 metadata when a new request explicitly is not Hardline', () => {
    expect(approvalOptionsForRequest({ hardline: false, riskLevel: 4, allowedScopes: ['once', 'session', 'workspace'] } as any).map((item) => item.scope)).toEqual(['once', 'session', 'workspace'])
  })
})
