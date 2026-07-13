export interface TopBarProps {
  onOpenProject: () => void
  terminalOpen?: boolean
  onToggleTerminal?: () => void
  subagentLogOpen?: boolean
  onToggleSubagentLogs?: () => void
  hasSubagentLogs?: boolean
  onOpenTasks?: () => void
  hasWorkspace?: boolean
}
