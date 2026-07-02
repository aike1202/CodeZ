import type { UnifiedTimelineItem } from '../ExecutionLog/utils'

export interface ExecutionLogDetailProps {
  item: UnifiedTimelineItem
  onFileClick?: (filePath: string, virtualContent?: string) => void
}
