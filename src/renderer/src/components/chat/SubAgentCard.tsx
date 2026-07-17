import React, { useMemo, useState } from 'react'
import IconLoading from '../icons/IconLoading'
import IconCheck from '../icons/IconCheck'
import IconWarning from '../icons/IconWarning'
import IconChevronDown from '../icons/IconChevronDown'
import { PanelRightOpen } from 'lucide-react'
import MessageBody from './MessageBody'
import { LogItemRow } from './ExecutionLog/components/LogItemRow'
import {
  buildFallbackTimeline,
  buildCommandItems,
  buildEditItems,
  buildUnifiedTimeline
} from './ExecutionLog/utils'
import type { SubAgentRecord } from '../../stores/chatStore'
import './SubAgentCard.css'

interface SubAgentCardProps {
  subAgent: SubAgentRecord
  defaultExpanded?: boolean
  onOpenDetails?: (subAgent: SubAgentRecord) => void
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

function fmtSmartDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min < 60) return `${min}m ${sec}s`
  const hr = Math.floor(min / 60)
  const rm = min % 60
  return `${hr}h ${rm}m ${sec}s`
}


export function SubAgentCard({
  subAgent,
  defaultExpanded,
  onOpenDetails,
  onFileClick,
  onDiffClick
}: SubAgentCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded ?? subAgent.status === 'running')
  const [showPrompt, setShowPrompt] = useState(false)
  const [showTimeline, setShowTimeline] = useState(true)
  const [showReply, setShowReply] = useState(false)
  const [itemExpandedMap, setItemExpandedMap] = useState<Record<string, boolean>>({})

  const toggleItemExpand = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setItemExpandedMap((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const isRunning = subAgent.status === 'running'
  const isFailed = subAgent.status === 'failed'
  const isInterrupted = subAgent.status === 'interrupted'
  const isLauncher = Boolean(onOpenDetails)

  const durationMs = useMemo(() => {
    const end = subAgent.completedAt || Date.now()
    return Math.max(end - subAgent.startedAt, 0)
  }, [subAgent.startedAt, subAgent.completedAt])

  const typeLabel = subAgent.type

  // 构建按时间排序的统一执行时间线（思考 / 文件 / 执行 混合，不分类）
  const innerTimeline = useMemo(() => {
    const normalized = buildFallbackTimeline(subAgent.executionTimeline, subAgent.reasoningContent)
    const cmds = buildCommandItems([])
    const edts = buildEditItems([])
    return buildUnifiedTimeline(normalized, cmds, edts, subAgent.reasoningContent, isRunning)
  }, [subAgent.executionTimeline, subAgent.reasoningContent, isRunning])

  // 判断某个时间线项是否有可展开的详情（复用 ExecutionLog 的判定逻辑）
  const hasItemDetail = (it: (typeof innerTimeline)[number]): boolean => {
    const isFileItem =
      it.type === 'edit' || (it.type === 'tool' && it.verb === 'Analyzed' && it.fileName)
    if (isFileItem) return false
    if (it.type === 'reasoning') return !!it.detail?.trim()
    if (it.type === 'tool') return !!it.args || !!it.detail
    if (it.type === 'command') return !!(it.detail && it.status !== 'running')
    return false
  }

  // AI 回复内容：优先用 result.output，其次用流式 content，最后用 structuredOutput 的 report
  const aiReply = useMemo(() => {
    const fromResult = subAgent.result?.output
    if (fromResult?.trim()) return fromResult.trim()
    const fromContent = subAgent.content
    if (fromContent?.trim()) return fromContent.trim()
    return null
  }, [subAgent.result?.output, subAgent.content])

  // 质量统计
  const qs = subAgent.result?.qualitySummary
  const filesExamined = subAgent.result?.filesExamined?.length ?? 0
  const toolCount = subAgent.toolCalls.length || subAgent.result?.toolCallCount || 0

  // 卡片标题：子智能体 ： XXX 用时Xm Xs
  const shortDesc = subAgent.description
    ? subAgent.description.length > 80
      ? subAgent.description.slice(0, 80) + '...'
      : subAgent.description
    : subAgent.prompt?.slice(0, 80) || typeLabel

  return (
    <div className={`subagent-card subagent-card--${subAgent.status}`}>
      {/* ── 头部：状态 + 类型徽章 + 标题 + meta + 折叠箭头 ── */}
      <button
        type="button"
        className="subagent-card-header"
        aria-label={isLauncher ? `打开子智能体日志：${shortDesc}` : undefined}
        aria-expanded={isLauncher ? undefined : expanded}
        onClick={() => {
          if (onOpenDetails) onOpenDetails(subAgent)
          else setExpanded((value) => !value)
        }}
      >
        <span className="subagent-card-status">
          {isRunning ? (
            <IconLoading width="14" height="14" className="spin-slow" />
          ) : isFailed || isInterrupted ? (
            <IconWarning width="14" height="14" className="subagent-card-status-icon--error" />
          ) : (
            <IconCheck width="14" height="14" style={{ color: 'var(--text-success, #059669)' }} />
          )}
        </span>

        <span className="subagent-card-prefix">子智能体</span>
        <span className="subagent-card-type-badge">{typeLabel}</span>

        <span className="subagent-card-title" title={shortDesc}>
          {shortDesc}
        </span>

        <span className="subagent-card-time">
          用时 {fmtSmartDuration(durationMs)}
        </span>

        {isLauncher ? (
          <PanelRightOpen
            width="14"
            height="14"
            className="subagent-card-open-icon"
            aria-hidden="true"
          />
        ) : (
          <IconChevronDown
            width="14"
            height="14"
            className={`subagent-card-chevron ${expanded ? 'subagent-card-chevron--expanded' : ''}`}
          />
        )}
      </button>

      {/* ── 折叠状态下也展示小条统计线 ── */}
      {(!expanded || isLauncher) && (
        <div className="subagent-card-meta-bar">
          <span>工具调用 {toolCount}</span>
          {filesExamined > 0 && <span>· 读取 {filesExamined} 文件</span>}
          {isRunning && <span className="subagent-card-meta-running">· 运行中…</span>}
          {isInterrupted && <span className="subagent-card-meta-running">· 已中断</span>}
          {subAgent.depth && <span>· {subAgent.depth}</span>}
        </div>
      )}

      {/* ── 展开体 ── */}
      {expanded && !isLauncher && (
        <div className="subagent-card-body">
          {/* 统计行 */}
          <div className="subagent-card-stats-row">
            <div className="subagent-card-stats-item">
              <span className="subagent-card-stats-num">{toolCount}</span>
              <span className="subagent-card-stats-label">工具调用</span>
            </div>
            <div className="subagent-card-stats-item">
              <span className="subagent-card-stats-num">{filesExamined}</span>
              <span className="subagent-card-stats-label">文件读取</span>
            </div>
            <div className="subagent-card-stats-item">
              <span className="subagent-card-stats-num">{fmtSmartDuration(durationMs)}</span>
              <span className="subagent-card-stats-label">总用时</span>
            </div>
            {subAgent.depth && (
              <div className="subagent-card-stats-item">
                <span className="subagent-card-stats-num">{subAgent.depth}</span>
                <span className="subagent-card-stats-label">探索深度</span>
              </div>
            )}
          </div>

          {/* 1. 任务安排 */}
          <div className="subagent-section">
            <button
              type="button"
              className="subagent-section-header"
              onClick={() => setShowPrompt((v) => !v)}
            >
              <span className="subagent-section-dot" />
              <span className="subagent-section-label">任务安排</span>
              <IconChevronDown
                width="12"
                height="12"
                className={`subagent-card-chevron ${showPrompt ? 'subagent-card-chevron--expanded' : ''}`}
              />
            </button>
            {showPrompt && (
              <div className="subagent-section-content subagent-section-content--prompt">
                {subAgent.prompt}
              </div>
            )}
          </div>

          {/* 2. 执行过程（思考 / 文件 / 命令 按时间顺序混合展示） */}
          {innerTimeline.length > 0 && (
            <div className="subagent-section">
              <button
                type="button"
                className="subagent-section-header"
                onClick={() => setShowTimeline((v) => !v)}
              >
                <span className="subagent-section-dot subagent-section-dot--thinking" />
                <span className="subagent-section-label">执行过程</span>
                <span className="subagent-section-badge">{innerTimeline.length}</span>
                <IconChevronDown
                  width="12"
                  height="12"
                  className={`subagent-card-chevron ${showTimeline ? 'subagent-card-chevron--expanded' : ''}`}
                />
              </button>
              {showTimeline && (
                <div className="subagent-section-content subagent-section-content--timeline">
                  {innerTimeline.map((ti, i) => (
                    ti.type === 'text' ? (
                      <div key={ti.id} className="subagent-progress-message">
                        <MessageBody
                          content={ti.detail || ''}
                          streaming={ti.status === 'running'}
                          onFileClick={(filePath) => onFileClick?.(filePath)}
                        />
                      </div>
                    ) : (
                      <LogItemRow
                        key={ti.id}
                        item={ti}
                        isLast={i === innerTimeline.length - 1}
                        isItemExpanded={Boolean(itemExpandedMap[ti.id])}
                        hasItemDetail={hasItemDetail(ti)}
                        toggleItemExpand={toggleItemExpand}
                        onFileClick={onFileClick}
                        onDiffClick={onDiffClick}
                      />
                    )
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 5. AI 回复内容 */}
          {aiReply && !isRunning && (
            <div className="subagent-section">
              <button
                type="button"
                className="subagent-section-header"
                onClick={() => setShowReply((v) => !v)}
              >
                <span className="subagent-section-dot subagent-section-dot--reply" />
                <span className="subagent-section-label">AI 回复</span>
                <IconChevronDown
                  width="12"
                  height="12"
                  className={`subagent-card-chevron ${showReply ? 'subagent-card-chevron--expanded' : ''}`}
                />
              </button>
              {showReply && (
                <div className="subagent-section-content subagent-section-content--reply">
                  <div className="subagent-reply-text">{aiReply}</div>
                  {qs?.coverage != null && (
                    <div className="subagent-reply-qual">
                      {typeof qs.coverage === 'number' && (
                        <span className="subagent-reply-qual-tag">覆盖 {Math.round(qs.coverage * 100)}%</span>
                      )}
                      {qs.confidence && <span className="subagent-reply-qual-tag">置信 {qs.confidence}</span>}
                      {typeof qs.unresolvedCount === 'number' && qs.unresolvedCount > 0 && (
                        <span className="subagent-reply-qual-tag subagent-reply-qual-tag--warn">
                          {qs.unresolvedCount} 未解决
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default SubAgentCard
