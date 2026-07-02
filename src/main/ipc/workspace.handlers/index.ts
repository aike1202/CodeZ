import { registerFileOpsHandlers, getWorkspaceService } from './fileOpsHandlers'
import { registerProjectAnalysisHandlers, getRecentStore } from './projectAnalysisHandlers'

export { getRecentStore, getWorkspaceService }

export function registerWorkspaceIpc(): void {
  registerFileOpsHandlers()
  registerProjectAnalysisHandlers()
}
