import type { UnifiedTimelineItem } from '../ExecutionLogUtils'

export interface ExecutionLogDetailProps {
  item: UnifiedTimelineItem
  onFileClick?: (filePath: string, virtualContent?: string) => void
}
