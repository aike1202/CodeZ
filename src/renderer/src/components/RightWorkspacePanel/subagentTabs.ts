export interface SubAgentWorkspaceTab {
  id: string
  subAgentId: string
}

export function createSubAgentWorkspaceTab(subAgentId: string): SubAgentWorkspaceTab {
  return {
    id: `subagent:${subAgentId}`,
    subAgentId
  }
}
