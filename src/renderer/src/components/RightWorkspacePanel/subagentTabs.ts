export interface SubAgentWorkspaceTab {
  id: string
  subAgentId: string
  instanceNumber: number
}

export function createSubAgentWorkspaceTab(
  subAgentId: string,
  instanceNumber: number
): SubAgentWorkspaceTab {
  return {
    id: `subagent:${subAgentId}:${instanceNumber}`,
    subAgentId,
    instanceNumber
  }
}

