import React, { useMemo, useState, useEffect } from 'react'
import Flex from '../../ui/Flex'
import Stack from '../../ui/Stack'
import IconLoading from '../../icons/IconLoading'
import IconCheck from '../../icons/IconCheck'
import {
  type UnifiedTimelineItem,
  buildFallbackTimeline,
  buildCommandItems,
  buildEditItems,
  buildUnifiedTimeline,
  buildSummaryText,
  extractAskSummary
} from './utils'
import './ExecutionLog.css'
import type { ExecutionLogProps } from './types'
import { LogItemRow } from './components/LogItemRow'
import SubAgentCard from '../SubAgentCard'

export default function ExecutionLog({
  timeline,
  reasoning,
  agentStates,
  onFileClick,
  onDiffClick,
  streaming,
  subAgents
}: ExecutionLogProps): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({})

  const normalizedTimeline = useMemo(() => buildFallbackTimeline(timeline, reasoning), [timeline, reasoning])
  const commands = useMemo(() => buildCommandItems(agentStates || []), [agentStates])
  const edits = useMemo(() => buildEditItems(agentStates || []), [agentStates])

  const unifiedItems = useMemo(
    () => buildUnifiedTimeline(normalizedTimeline, commands, edits, reasoning, streaming),
    [normalizedTimeline, commands, edits, reasoning, streaming]
  )

  const running = useMemo(() => {
    return Boolean(streaming) || unifiedItems.some((item) => item.status === 'running')
  }, [unifiedItems, streaming])

  useEffect(() => {
    if (running) {
      setExpanded(true)
    } else {
      const timer = setTimeout(() => {
        setExpanded(false)
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [running])

  const lastReasoningItem = useMemo(() => {
    for (let i = unifiedItems.length - 1; i >= 0; i--) {
      if (unifiedItems[i].type === 'reasoning') {
        return unifiedItems[i]
      }
    }
    return null
  }, [unifiedItems])

  const lastReasoningId = lastReasoningItem?.id || ''
  const lastReasoningStatus = lastReasoningItem?.status || ''
  const itemsCount = unifiedItems.length

  useEffect(() => {
    if (itemsCount === 0) return

    setExpandedMap((prev) => {
      const next: Record<string, boolean> = { ...prev }

      unifiedItems.forEach((item) => {
        const isLatestReasoning = lastReasoningItem && item.id === lastReasoningItem.id
        if (isLatestReasoning && item.status === 'running') {
          next[item.id] = true
        } else {
          next[item.id] = false
        }
      })

      return next
    })
  }, [lastReasoningId, lastReasoningStatus, itemsCount])

  if (unifiedItems.length === 0) return null

  const summary = buildSummaryText(unifiedItems, running)
  const askSummary = useMemo(() => extractAskSummary(unifiedItems), [unifiedItems])

  const hasDetail = (item: UnifiedTimelineItem) => {
    const isFileItem = item.type === 'edit' || (item.type === 'tool' && item.verb === 'Analyzed' && item.fileName)
    if (isFileItem) return false

    if (item.type === 'reasoning') {
      return !!item.detail?.trim()
    }
    if (item.type === 'tool') {
      return !!item.args || !!item.detail
    }
    if (item.type === 'command') {
      return !!(item.detail && item.status !== 'running')
    }
    return false
  }

  const toggleItemExpand = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setExpandedMap((prev) => ({
      ...prev,
      [id]: !prev[id]
    }))
  }

  return (
    <div className="timeline-container">
      <button
        type="button"
        className="timeline-header-btn"
        onClick={() => setExpanded((val) => !val)}
      >
        <div className="timeline-header-content">
          <Flex align="center" gap={2} className="timeline-header-text">
            {running ? (
              <IconLoading width="12" height="12" className="spin-slow" />
            ) : (
              <IconCheck
                width="12"
                height="12"
                className="timeline-icon-success"
                style={{ color: 'var(--text-success, #059669)' }}
              />
            )}
            <span>{askSummary ? `已提问：${askSummary.question}` : summary}</span>
          </Flex>
          {askSummary && (
            <div className="timeline-header-answer">
              {askSummary.answer ? (
                <>
                  <span className="timeline-header-answer-label">用户回答：</span>
                  <span className="timeline-header-answer-val">{askSummary.answer}</span>
                </>
              ) : (
                <span className="timeline-header-answer-pending">等待用户回答…</span>
              )}
            </div>
          )}
        </div>
        <span className="timeline-header-arrow-text">{expanded ? '收起' : '展开'}</span>
      </button>

      <div className={`timeline-list-wrapper ${expanded ? 'timeline-list-wrapper--expanded' : ''}`}>
        <Stack className="timeline-list">
          {unifiedItems.map((item, idx) => {
            const isOrchestratorTool =
              item.toolName === 'DelegateTasks' ||
              item.toolName === 'spawn'

            const matchedSubAgent =
              item.type === 'tool' &&
              (item.toolName === 'SubAgentRunner' ||
                isOrchestratorTool)
                ? subAgents?.find((s) => s.parentToolCallId === item.id)
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
                isLast={idx === unifiedItems.length - 1}
                isItemExpanded={Boolean(expandedMap[item.id])}
                hasItemDetail={hasDetail(item)}
                toggleItemExpand={toggleItemExpand}
                onFileClick={onFileClick}
                onDiffClick={onDiffClick}
              />
            )
          })}
        </Stack>
      </div>
    </div>
  )
}

export type { ExecutionLogProps } from './types'
