import type { UnifiedTimelineItem } from './types'

export function buildSummaryText(items: UnifiedTimelineItem[], running: boolean): string {
  const readCount = items.filter((i) => i.type === 'tool' && i.verb === 'Analyzed').length
  const dirCount = items.filter((i) => i.type === 'tool' && i.verb === 'Explored').length
  const searchCount = items.filter((i) => i.verb === 'Searched').length
  const cmdCount = items.filter((i) => i.type === 'command').length
  const editCount = items.filter((i) => i.type === 'edit').length

  const parts = [
    readCount > 0 ? `${readCount} 个文件` : '',
    dirCount > 0 ? `${dirCount} 个目录` : '',
    searchCount > 0 ? `${searchCount} 次搜索` : '',
    cmdCount > 0 ? `${cmdCount} 条命令` : '',
    editCount > 0 ? `${editCount} 处修改` : ''
  ].filter(Boolean)

  const prefix = running ? '正在处理: ' : '已探索: '
  return parts.length > 0 ? `${prefix}${parts.join(', ')}` : running ? '运行中...' : '已完成'
}
