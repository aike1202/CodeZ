import { describe, expect, it } from 'vitest'
import { approvalLabelForRequest, approvalOptionsForRequest } from '../renderer/src/components/chat/permissionApprovalOptions'

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

  it('explains why approval is required', () => {
    expect(approvalLabelForRequest({
      hardline: false, absoluteRedline: false, analysisStatus: 'parsed', approvalSource: 'model-requested'
    } as any)).toBe('模型请求确认')
    expect(approvalLabelForRequest({
      hardline: false, absoluteRedline: false, analysisStatus: 'parsed', approvalSource: 'runtime-policy'
    } as any)).toBe('权限策略要求确认')
    expect(approvalLabelForRequest({
      hardline: true, absoluteRedline: true, analysisStatus: 'parsed', approvalSource: 'absolute-redline'
    } as any)).toBe('绝对红线：必须确认')
  })
})
