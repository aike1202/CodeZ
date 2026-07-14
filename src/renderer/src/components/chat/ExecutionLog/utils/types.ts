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
  toolName?: string
  args?: string
}

export interface UnifiedTimelineItem {
  id: string
  type: 'reasoning' | 'tool' | 'command' | 'edit' | 'text' | 'compaction'
  timestamp: number
  completedAt?: number
  batchId?: string
  batchIndex?: number
  batchSize?: number
  batchKind?: 'tools' | 'read' | 'explore'
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
    | 'Submitting'
    | 'Submitted'
    | 'Dispatching'
    | 'Dispatched'
    | 'Saving'
    | 'Saved'
    | 'Updating'
    | 'Updated'
    | 'Fetching'
    | 'Fetched'
    | 'Invoking'
    | 'Invoked'
    | 'Deactivating'
    | 'Deactivated'
    | 'Compacting'
    | 'Compacted'
    | 'CompactionFailed'
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

export interface ParallelToolBatchItem {
  id: string
  type: 'parallel-batch'
  batchId: string
  batchSize: number
  batchKind: 'tools' | 'read' | 'explore'
  timestamp: number
  status: 'running' | 'success' | 'error'
  items: UnifiedTimelineItem[]
}

export type ExecutionLogDisplayItem = UnifiedTimelineItem | ParallelToolBatchItem

export type EditItemWithStatus = EditItem & {
  status: 'running' | 'success' | 'error'
  isRunning: boolean
}
