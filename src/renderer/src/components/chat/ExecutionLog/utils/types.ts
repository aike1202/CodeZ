export type CommandItem = {
  id: string
  title: string
  status: 'running' | 'success' | 'error'
  timestamp: number
}

export type EditItem = {
  id: string
  filePath: string
  additions: string
  deletions: string
  timestamp: number
}

export interface UnifiedTimelineItem {
  id: string
  type: 'reasoning' | 'tool' | 'command' | 'edit' | 'text'
  timestamp: number
  status: 'running' | 'success' | 'error'
  verb:
    | 'Thought'
    | 'Analyzed'
    | 'Analyzing'
    | 'Explored'
    | 'Exploring'
    | 'Searched'
    | 'Searching'
    | 'Terminal'
    | 'Edited'
    | 'Created'
    | 'Editing'
    | 'Creating'
    | 'Executed'
    | 'Executing'
    | 'Asked'
    | 'Asking'
  target: string
  detail?: string
  args?: string
  duration?: string
  additions?: string
  deletions?: string
  fileName?: string
  toolName?: string
  realPath?: string
}

export type EditItemWithStatus = EditItem & {
  status: 'running' | 'success' | 'error'
  isRunning: boolean
}
