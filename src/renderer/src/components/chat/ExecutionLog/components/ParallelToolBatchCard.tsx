import React, { useEffect, useState } from 'react'
import { CheckCircle2, ChevronDown, Loader2, XCircle, Zap } from 'lucide-react'
import type { ParallelToolBatchItem, UnifiedTimelineItem } from '../utils'
import { getParallelBatchDuration } from '../utils'
import type { SubAgentRecord } from '../../../../stores/chatStore'
import SubAgentCard from '../../SubAgentCard'
import { LogItemRow } from './LogItemRow'
import './ParallelToolBatchCard.css'

interface ParallelToolBatchCardProps {
  batch: ParallelToolBatchItem
  expandedMap: Record<string, boolean>
  hasItemDetail: (item: UnifiedTimelineItem) => boolean
  toggleItemExpand: (id: string, event: React.MouseEvent) => void
  subAgents?: SubAgentRecord[]
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
  subAgents,
  onFileClick,
  onDiffClick
}: ParallelToolBatchCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState(true)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (batch.status !== 'running') return

    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [batch.status])

  const failedCount = batch.items.filter((item) => item.status === 'error').length
  const duration = getParallelBatchDuration(batch, now)
  const title = batch.batchKind === 'read'
    ? batch.status === 'running'
      ? `正在并行读取 ${batch.batchSize} 个文件`
      : `并行读取 ${batch.batchSize} 个文件`
    : batch.status === 'running'
      ? `正在并行执行 ${batch.batchSize} 项`
      : `并行执行 ${batch.batchSize} 项`

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
        <Zap size={13} className="parallel-tool-batch-zap" />
        <span className="parallel-tool-batch-title">{title}</span>
        {failedCount > 0 && (
          <span className="parallel-tool-batch-failures">· {failedCount} 项失败</span>
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
            const isOrchestratorTool =
              item.toolName === 'DelegateTasks' ||
              item.toolName === 'spawn'
            const matchedSubAgent =
              item.type === 'tool' &&
              (item.toolName === 'SubAgentRunner' || isOrchestratorTool)
                ? subAgents?.find((subAgent) => subAgent.parentToolCallId === item.id)
                : undefined

            if (matchedSubAgent) {
              return (
                <SubAgentCard
                  key={item.id}
                  subAgent={matchedSubAgent}
                  onFileClick={onFileClick}
                  onDiffClick={onDiffClick}
                />
              )
            }

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
