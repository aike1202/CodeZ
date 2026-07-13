import { describe, expect, it } from 'vitest'
import {
  getDiffPreviewTabId,
  getFilePreviewTabId
} from '../renderer/src/App/hooks/useAppPreview'
import { createSubAgentWorkspaceTab } from '../renderer/src/components/RightWorkspacePanel/subagentTabs'

describe('right workspace preview tab identity', () => {
  it('deduplicates Windows paths regardless of case or line suffix', () => {
    expect(getFilePreviewTabId('F:\\Project\\src\\App.tsx:42')).toBe(
      getFilePreviewTabId('f:/project/src/app.tsx')
    )
  })

  it('keeps file and diff pages in separate tabs', () => {
    const filePath = 'F:\\Project\\src\\App.tsx'
    expect(getFilePreviewTabId(filePath)).not.toBe(getDiffPreviewTabId(filePath))
  })

  it('uses one stable tab identity for repeated opens of the same subagent', () => {
    const firstTab = createSubAgentWorkspaceTab('agent-1')
    const secondTab = createSubAgentWorkspaceTab('agent-1')

    expect(firstTab.subAgentId).toBe(secondTab.subAgentId)
    expect(firstTab.id).toBe(secondTab.id)
  })
})
