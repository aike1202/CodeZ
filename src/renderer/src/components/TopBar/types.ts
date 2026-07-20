export interface TopBarProps {
  onOpenProject: () => void
  terminalOpen?: boolean
  onToggleTerminal?: () => void
  subagentsOpen?: boolean
  onToggleSubagents?: () => void
  onOpenTasks?: () => void
  hasWorkspace?: boolean
}
