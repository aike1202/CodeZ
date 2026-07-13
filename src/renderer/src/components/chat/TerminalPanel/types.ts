export interface TerminalTab {
  id: string
  name: string
}

export interface TerminalPanelProps {
  workspaceId: string
  rootPath: string
  height?: number
  setHeight?: (height: number) => void
  onClose: () => void
  sidebarWidth?: number
  previewPanelWidth?: number
  layout?: 'bottom' | 'side'
  visible?: boolean
}
