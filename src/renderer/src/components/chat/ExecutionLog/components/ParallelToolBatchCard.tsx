import React, { useEffect, useState } from 'react'
import { CheckCircle2, ChevronDown, FolderSearch2, ListTree, Loader2, XCircle } from 'lucide-react'
import type { ParallelToolBatchItem, UnifiedTimelineItem } from '../utils'
import { getParallelBatchDuration } from '../utils'
import { LogItemRow } from './LogItemRow'
import './ParallelToolBatchCard.css'

interface ParallelToolBatchCardProps {
  batch: ParallelToolBatchItem
  expandedMap: Record<string, boolean>
  hasItemDetail: (item: UnifiedTimelineItem) => boolean
  toggleItemExpand: (id: string, event: React.MouseEvent) => void
  onFileClick?: (filePath: string, virtualContent?: string) => void
  onDiffClick?: (
    filePath: string,
    editInfo: {
      type: 'write' | 'replace'
      targetContent?: string
      replacementContent?: string
      codeContent?: string
    }
  ) => void
}

function formatBatchDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`
  if (durationMs < 10000) return `${(durationMs / 1000).toFixed(1)}s`
  return `${Math.round(durationMs / 1000)}s`
}

export function ParallelToolBatchCard({
  batch,
  expandedMap,
  hasItemDetail,
  toggleItemExpand,
  onFileClick,
  onDiffClick
}: ParallelToolBatchCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState(batch.batchKind !== 'explore')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (batch.status !== 'running') return

    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [batch.status])

  const failedCount = batch.items.filter((item) => item.status === 'error').length
  const emptyCount = batch.batchKind === 'explore'
    ? batch.items.filter((item) => item.detail?.trim() === 'No files matched.').length
    : 0
  const duration = getParallelBatchDuration(batch, now)
  const title = batch.batchKind === 'explore'
    ? batch.status === 'running'
      ? `本轮正在浏览 ${batch.batchSize} 处位置`
      : `本轮浏览了 ${batch.batchSize} 处位置`
    : batch.batchKind === 'read'
    ? batch.status === 'running'
      ? `本轮正在读取 ${batch.batchSize} 个文件`
      : `本轮读取 ${batch.batchSize} 个文件`
    : batch.status === 'running'
      ? `本轮正在执行 ${batch.batchSize} 项`
      : `本轮已执行 ${batch.batchSize} 项`

  const statusIcon = batch.status === 'running'
    ? <Loader2 size={14} className="parallel-tool-batch-icon parallel-tool-batch-icon--running" />
    : batch.status === 'error'
      ? <XCircle size={14} className="parallel-tool-batch-icon parallel-tool-batch-icon--error" />
      : <CheckCircle2 size={14} className="parallel-tool-batch-icon parallel-tool-batch-icon--success" />

  return (
    <div className={`parallel-tool-batch-card parallel-tool-batch-card--${batch.status}`}>
      <button
        type="button"
        className="parallel-tool-batch-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="parallel-tool-batch-status">{statusIcon}</span>
        {batch.batchKind === 'explore'
          ? <FolderSearch2 size={14} className="parallel-tool-batch-zap" />
          : <ListTree size={14} className="parallel-tool-batch-zap" />}
        <span className="parallel-tool-batch-title">{title}</span>
        {failedCount > 0 && (
          <span className="parallel-tool-batch-failures">· {failedCount} 项失败</span>
        )}
        {emptyCount > 0 && (
          <span className="parallel-tool-batch-empty">· {emptyCount} 项无匹配</span>
        )}
        <span className="parallel-tool-batch-time">{formatBatchDuration(duration)}</span>
        <ChevronDown
          size={14}
          className={`parallel-tool-batch-chevron ${expanded ? 'parallel-tool-batch-chevron--expanded' : ''}`}
        />
      </button>

      {expanded && (
        <div className="parallel-tool-batch-body">
          {batch.items.map((item, index) => {
            return (
              <LogItemRow
                key={item.id}
                item={item}
                isLast={index === batch.items.length - 1}
                isItemExpanded={Boolean(expandedMap[item.id])}
                hasItemDetail={hasItemDetail(item)}
                toggleItemExpand={toggleItemExpand}
                onFileClick={onFileClick}
                onDiffClick={onDiffClick}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
