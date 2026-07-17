import React, { useMemo, useState, useEffect } from 'react'
import Flex from '../../ui/Flex'
import Stack from '../../ui/Stack'
import IconLoading from '../../icons/IconLoading'
import IconCheck from '../../icons/IconCheck'
import IconWarning from '../../icons/IconWarning'
import {
  type UnifiedTimelineItem,
  buildFallbackTimeline,
  buildCommandItems,
  buildEditItems,
  buildUnifiedTimeline,
  buildSummaryText,
  extractAskSummary,
  groupParallelToolBatches
} from './utils'
import './ExecutionLog.css'
import type { ExecutionLogProps } from './types'
import { LogItemRow } from './components/LogItemRow'
import { ParallelToolBatchCard } from './components/ParallelToolBatchCard'
import SubAgentCard from '../SubAgentCard'
import { ParallelWaveGroup } from '../ParallelWaveGroup'
import { isRuntimeFallbackParent } from '../../../utils/runtimeSubAgents'

export default function ExecutionLog({
  timeline,
  reasoning,
  agentStates,
  toolCalls,
  onFileClick,
  onDiffClick,
  streaming,
  interrupted,
  subAgents,
  onSubAgentClick,
  showParallelExecution = false
}: ExecutionLogProps): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({})

  const normalizedTimeline = useMemo(() => buildFallbackTimeline(timeline, reasoning), [timeline, reasoning])
  const commands = useMemo(() => buildCommandItems(agentStates || []), [agentStates])
  const edits = useMemo(() => buildEditItems(agentStates || [], toolCalls), [agentStates, toolCalls])

  const unifiedItems = useMemo(
    () => buildUnifiedTimeline(normalizedTimeline, commands, edits, reasoning, streaming),
    [normalizedTimeline, commands, edits, reasoning, streaming]
  )
  const displayItems = useMemo(() => groupParallelToolBatches(unifiedItems), [unifiedItems])
  const visibleSubAgents = useMemo(() => {
    if (!subAgents?.length) return []
    const parentToolIds = new Set(unifiedItems.map((item) => item.id))
    return subAgents.filter((subAgent) =>
      parentToolIds.has(subAgent.parentToolCallId)
      || (showParallelExecution && (
        unifiedItems.length === 0 || isRuntimeFallbackParent(subAgent.parentToolCallId)
      ))
    )
  }, [showParallelExecution, subAgents, unifiedItems])
  const subAgentsByParent = useMemo(() => {
    const grouped = new Map<string, typeof visibleSubAgents>()
    for (const subAgent of visibleSubAgents) {
      const siblings = grouped.get(subAgent.parentToolCallId) ?? []
      grouped.set(subAgent.parentToolCallId, [...siblings, subAgent])
    }
    return grouped
  }, [visibleSubAgents])
  const matchedSubAgentIds = useMemo(() => {
    const matched = new Set<string>()
    for (const item of displayItems) {
      const timelineIds = item.type === 'parallel-batch'
        ? item.items.map((child) => child.id)
        : [item.id]
      for (const timelineId of timelineIds) {
        for (const subAgent of subAgentsByParent.get(timelineId) ?? []) {
          matched.add(subAgent.id)
        }
      }
    }
    return matched
  }, [displayItems, subAgentsByParent])
  const unmatchedSubAgents = useMemo(
    () => visibleSubAgents.filter((subAgent) => !matchedSubAgentIds.has(subAgent.id)),
    [matchedSubAgentIds, visibleSubAgents]
  )

  const running = useMemo(() => {
    return !interrupted && (
      Boolean(streaming) || unifiedItems.some((item) => item.status === 'running')
      || visibleSubAgents.some((subAgent) => subAgent.status === 'running')
    )
  }, [unifiedItems, visibleSubAgents, streaming, interrupted])

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

  const askSummary = useMemo(() => extractAskSummary(unifiedItems), [unifiedItems])
  if (unifiedItems.length === 0 && visibleSubAgents.length === 0) return null

  const summary = unifiedItems.length > 0
    ? buildSummaryText(unifiedItems, running, interrupted)
    : running ? '子智能体运行中' : '子智能体已结束'
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

  const subAgentCardsFor = (parentIds: string[], placement: 'inline' | 'fallback') => {
    const records = [...new Map(
      parentIds
        .flatMap((parentId) => subAgentsByParent.get(parentId) ?? [])
        .map((subAgent) => [subAgent.id, subAgent])
    ).values()]
    if (records.length === 0) return null
    return (
      <div className={`subagent-launcher-list subagent-launcher-list--${placement}`}>
        {records.map((subAgent) => (
          <SubAgentCard
            key={subAgent.id}
            subAgent={subAgent}
            onOpenDetails={onSubAgentClick}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="timeline-container">
      {showParallelExecution ? <ParallelWaveGroup /> : null}
      <button
        type="button"
        className="timeline-header-btn"
        aria-expanded={expanded}
        onClick={() => setExpanded((val) => !val)}
      >
        <div className="timeline-header-content">
          <Flex align="center" gap={2} className="timeline-header-text">
            {interrupted ? (
              <IconWarning width="12" height="12" className="subagent-card-status-icon--error" />
            ) : running ? (
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

      <div className="timeline-list-wrapper" hidden={!expanded}>
        <Stack className="timeline-list">
          {displayItems.map((item, idx) => {
            if (item.type === 'parallel-batch') {
              return (
                <React.Fragment key={item.id}>
                  <ParallelToolBatchCard
                    batch={item}
                    expandedMap={expandedMap}
                    hasItemDetail={hasDetail}
                    toggleItemExpand={toggleItemExpand}
                    onFileClick={onFileClick}
                    onDiffClick={onDiffClick}
                  />
                  {subAgentCardsFor(item.items.map((child) => child.id), 'inline')}
                </React.Fragment>
              )
            }

            return (
              <React.Fragment key={item.id}>
                <LogItemRow
                  item={item}
                  isLast={idx === displayItems.length - 1}
                  isItemExpanded={Boolean(expandedMap[item.id])}
                  hasItemDetail={hasDetail(item)}
                  toggleItemExpand={toggleItemExpand}
                  onFileClick={onFileClick}
                  onDiffClick={onDiffClick}
                />
                {subAgentCardsFor([item.id], 'inline')}
              </React.Fragment>
            )
          })}
        </Stack>
      </div>
      {unmatchedSubAgents.length > 0
        ? subAgentCardsFor(unmatchedSubAgents.map((subAgent) => subAgent.parentToolCallId), 'fallback')
        : null}
    </div>
  )
}

export type { ExecutionLogProps } from './types'
