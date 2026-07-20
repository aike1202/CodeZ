import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleStop,
  FileText,
  LoaderCircle,
  MessageSquareMore,
  RefreshCw,
  RotateCcw,
  Send,
  Wrench
} from 'lucide-react'
import type {
  AgentArtifact,
  AgentAttempt,
  AgentDetail,
  AgentState,
  AgentSummary,
  AgentUsage,
  AgentUiEventEnvelope,
  AgentWorkspaceRecoveryRecord
} from '../../shared/desktop/generated/contracts'
import { desktopApi } from '../../shared/desktop'
import './SubAgentPanel.css'

const AGENT_LIST_BATCH = 10
const EVENT_PAGE_SIZE = 100
const MAX_CACHED_EVENTS = 1_000

export interface SelectedSubAgent {
  rootRunId: string
  agentId: string
}

interface SubAgentPanelProps {
  sessionId: string | null
  selectedAgent: SelectedSubAgent | null
  onSelectAgent: (agent: SelectedSubAgent | null) => void
}

interface DisplayEvent {
  key: string
  kind: AgentUiEventEnvelope['kind']
  occurredAt: string
  title: string
  body: string
  status?: string
  agentHandles?: SpawnedAgentHandle[]
}

interface SpawnedAgentHandle {
  agentId: string
  state?: AgentState
}

type EventFilter = 'all' | 'output' | 'tools' | 'communication' | 'errors'

const EVENT_FILTERS: ReadonlyArray<{ value: EventFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'output', label: '输出' },
  { value: 'tools', label: '工具' },
  { value: 'communication', label: '通信' },
  { value: 'errors', label: '错误' }
]

const ACTIVE_STATES = new Set<AgentState>([
  'created',
  'queued',
  'starting',
  'running',
  'waiting_message',
  'waiting_children',
  'awaiting_approval',
  'needs_replan',
  'needs_resolution'
])

const STATE_LABELS: Record<AgentState, string> = {
  created: '已创建',
  queued: '排队中',
  starting: '启动中',
  running: '运行中',
  waiting_message: '等待消息',
  waiting_children: '等待子任务',
  awaiting_approval: '等待批准',
  needs_replan: '需要重排',
  needs_resolution: '需要处理',
  completed: '已完成',
  blocked: '已阻塞',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断'
}

const PROFILE_LABELS: Record<AgentSummary['profile'], string> = {
  general: '通用',
  explore: '研究',
  review: '审核',
  integration: '集成'
}

export default function SubAgentPanel({
  sessionId,
  selectedAgent,
  onSelectAgent
}: SubAgentPanelProps): React.ReactElement {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [listCursor, setListCursor] = useState(0)
  const [listHasMore, setListHasMore] = useState(false)
  const [listLoading, setListLoading] = useState(false)
  const [detail, setDetail] = useState<AgentDetail | null>(null)
  const [artifacts, setArtifacts] = useState<AgentArtifact[]>([])
  const [recoveryRecords, setRecoveryRecords] = useState<AgentWorkspaceRecoveryRecord[]>([])
  const [events, setEvents] = useState<AgentUiEventEnvelope[]>([])
  const [eventCursor, setEventCursor] = useState(0)
  const [eventHasMore, setEventHasMore] = useState(false)
  const [eventFilter, setEventFilter] = useState<EventFilter>('all')
  const [detailLoading, setDetailLoading] = useState(false)
  const [actionPending, setActionPending] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const selectedRef = useRef<SelectedSubAgent | null>(selectedAgent)
  const attemptRef = useRef<string | null>(null)

  const currentAttempt = useMemo<AgentAttempt | null>(() => {
    if (!detail || detail.attempts.length === 0) return null
    return detail.attempts[detail.attempts.length - 1]
  }, [detail])

  const currentRecovery = useMemo(() => recoveryRecords.filter((record) => (
    record.disposition === 'manual_intervention'
    && record.rootRunId === selectedAgent?.rootRunId
    && record.agentId === selectedAgent?.agentId
  )), [recoveryRecords, selectedAgent?.rootRunId, selectedAgent?.agentId])

  const displayEvents = useMemo(() => buildDisplayEvents(events), [events])
  const filteredDisplayEvents = useMemo(
    () => displayEvents.filter((event) => eventMatchesFilter(event, eventFilter)),
    [displayEvents, eventFilter]
  )

  useEffect(() => {
    selectedRef.current = selectedAgent
  }, [selectedAgent])

  useEffect(() => {
    attemptRef.current = currentAttempt?.id ?? null
  }, [currentAttempt?.id])

  const loadAgentPage = useCallback(async (cursor: number, replace: boolean) => {
    if (!sessionId) return
    setListLoading(true)
    setError(null)
    try {
      const page = await desktopApi.agent.list(sessionId, cursor, AGENT_LIST_BATCH)
      setAgents((current) => replace ? page.agents : mergeAgents(current, page.agents))
      setListCursor(page.nextCursor)
      setListHasMore(page.hasMore)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setListLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    setAgents([])
    setListCursor(0)
    setListHasMore(false)
    setDetail(null)
    setArtifacts([])
    setRecoveryRecords([])
    setEvents([])
    setMessage('')
    if (sessionId) {
      void loadAgentPage(0, true)
      void desktopApi.agent.listWorkspaceRecovery()
        .then(setRecoveryRecords)
        .catch(() => undefined)
    }
  }, [sessionId, loadAgentPage])

  const loadDetail = useCallback(async (selection: SelectedSubAgent) => {
    setDetailLoading(true)
    setError(null)
    setEvents([])
    setEventCursor(0)
    setEventHasMore(false)
    try {
      const [nextDetail, nextArtifacts, nextRecovery] = await Promise.all([
        desktopApi.agent.inspect(selection.rootRunId, selection.agentId),
        desktopApi.agent.getArtifacts(selection.rootRunId, selection.agentId),
        desktopApi.agent.listWorkspaceRecovery()
      ])
      const attempt = nextDetail.attempts[nextDetail.attempts.length - 1]
      const page = attempt
        ? await desktopApi.agent.getEvents(
          selection.rootRunId,
          selection.agentId,
          attempt.id,
          0,
          EVENT_PAGE_SIZE
        )
        : { events: [], nextCursor: 0, hasMore: false }
      if (
        selectedRef.current?.rootRunId !== selection.rootRunId
        || selectedRef.current.agentId !== selection.agentId
      ) return
      setDetail(nextDetail)
      setArtifacts(nextArtifacts)
      setRecoveryRecords(nextRecovery)
      setEvents(page.events)
      setEventCursor(page.nextCursor)
      setEventHasMore(page.hasMore)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      if (
        selectedRef.current?.rootRunId === selection.rootRunId
        && selectedRef.current.agentId === selection.agentId
      ) setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!selectedAgent) {
      setDetail(null)
      setArtifacts([])
      setEvents([])
      setDetailLoading(false)
      return
    }
    void loadDetail(selectedAgent)
  }, [selectedAgent?.rootRunId, selectedAgent?.agentId, loadDetail])

  useEffect(() => desktopApi.agent.onUiEvent((event) => {
    setAgents((current) => updateAgentSummary(current, event))
    const selected = selectedRef.current
    if (
      !selected
      || event.rootRunId !== selected.rootRunId
      || event.agentId !== selected.agentId
      || event.attemptId !== attemptRef.current
    ) return
    setEvents((current) => appendEvent(current, event))
    if (event.kind === 'stateChanged' || event.kind === 'resultSubmitted') {
      void Promise.all([
        desktopApi.agent.inspect(selected.rootRunId, selected.agentId),
        desktopApi.agent.getArtifacts(selected.rootRunId, selected.agentId)
      ])
        .then(([nextDetail, nextArtifacts]) => {
          if (
            selectedRef.current?.rootRunId === selected.rootRunId
            && selectedRef.current.agentId === selected.agentId
          ) {
            setDetail(nextDetail)
            setArtifacts(nextArtifacts)
          }
        })
        .catch(() => undefined)
    }
  }), [])

  const loadMoreEvents = useCallback(async () => {
    const selection = selectedRef.current
    const attemptId = attemptRef.current
    if (!selection || !attemptId || detailLoading) return
    setDetailLoading(true)
    try {
      const page = await desktopApi.agent.getEvents(
        selection.rootRunId,
        selection.agentId,
        attemptId,
        eventCursor,
        EVENT_PAGE_SIZE
      )
      setEvents((current) => mergeEvents(current, page.events))
      setEventCursor(page.nextCursor)
      setEventHasMore(page.hasMore)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setDetailLoading(false)
    }
  }, [detailLoading, eventCursor])

  const runAction = useCallback(async (action: () => Promise<unknown>) => {
    setActionPending(true)
    setError(null)
    try {
      await action()
      const selected = selectedRef.current
      if (selected) await loadDetail(selected)
      if (sessionId) await loadAgentPage(0, true)
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      setActionPending(false)
    }
  }, [loadAgentPage, loadDetail, sessionId])

  const submitMessage = useCallback(() => {
    const selected = selectedRef.current
    const trimmed = message.trim()
    if (!selected || !trimmed || actionPending) return
    const isActive = detail ? ACTIVE_STATES.has(detail.node.state) : false
    void runAction(() => isActive
      ? desktopApi.agent.sendMessage(selected.rootRunId, selected.agentId, trimmed)
      : desktopApi.agent.followup(selected.rootRunId, selected.agentId, trimmed)
    ).then((succeeded) => {
      if (succeeded) setMessage('')
    })
  }, [actionPending, detail, message, runAction])

  if (!selectedAgent) {
    const titlesByAgentId = new Map(agents.map((agent) => [agent.agentId, agent.title]))
    const activeAgents = agents
      .filter((agent) => ACTIVE_STATES.has(agent.state))
      .sort(compareAgentActivity)
    const completedAgents = agents
      .filter((agent) => !ACTIVE_STATES.has(agent.state))
      .sort(compareAgentActivity)
    return (
      <div className="subagent-panel subagent-list-view">
        <header className="subagent-view-header">
          <div>
            <h2>全部分身</h2>
            <span>{agents.length} 个</span>
          </div>
          <button
            type="button"
            className="subagent-icon-button"
            title="刷新分身列表"
            aria-label="刷新分身列表"
            disabled={!sessionId || listLoading}
            onClick={() => void loadAgentPage(0, true)}
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </header>
        {error ? <InlineError message={error} /> : null}
        <div className="subagent-list">
          <AgentListSection
            title="已开启"
            agents={activeAgents}
            emptyText="没有已开启的子智能体"
            titlesByAgentId={titlesByAgentId}
            onSelectAgent={onSelectAgent}
          />
          <AgentListSection
            title={`完成 · ${completedAgents.length}`}
            agents={completedAgents}
            emptyText={agents.length === 0 && !listLoading ? '暂无分身记录' : '暂无完成记录'}
            titlesByAgentId={titlesByAgentId}
            onSelectAgent={onSelectAgent}
          />
        </div>
        <div className="subagent-list-footer">
          {listLoading ? <LoaderCircle className="subagent-spin" size={15} aria-hidden="true" /> : null}
          {listHasMore && !listLoading ? (
            <button type="button" onClick={() => void loadAgentPage(listCursor, false)}>
              加载更多
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  const state = detail?.node.state
  const isActive = state ? ACTIVE_STATES.has(state) : false
  const canResume = state === 'interrupted' || state === 'failed'

  return (
    <div className="subagent-panel subagent-detail-view">
      <header className="subagent-detail-header">
        <button
          type="button"
          className="subagent-icon-button"
          title="返回全部分身"
          aria-label="返回全部分身"
          onClick={() => onSelectAgent(null)}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <div className="subagent-detail-heading">
          <h2>{detail?.node.task.title ?? '分身详情'}</h2>
          {state ? (
            <span className={`subagent-state subagent-state--${stateTone(state)}`}>
              {STATE_LABELS[state]}
            </span>
          ) : null}
        </div>
        <div className="subagent-detail-actions">
          {canResume ? (
            <button
              type="button"
              className="subagent-icon-button"
              title="恢复分身"
              aria-label="恢复分身"
              disabled={actionPending}
              onClick={() => void runAction(() => desktopApi.agent.resume(
                selectedAgent.rootRunId,
                selectedAgent.agentId
              ))}
            >
              <RotateCcw size={15} aria-hidden="true" />
            </button>
          ) : null}
          {isActive ? (
            <button
              type="button"
              className="subagent-icon-button subagent-icon-button--danger"
              title="停止分身"
              aria-label="停止分身"
              disabled={actionPending}
              onClick={() => void runAction(() => desktopApi.agent.cancel(
                selectedAgent.rootRunId,
                selectedAgent.agentId
              ))}
            >
              <CircleStop size={15} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      {error ? <InlineError message={error} /> : null}
      {currentRecovery.map((record) => (
        <InlineError key={`${record.manifestPath}:${record.status}`} message={record.detail} />
      ))}

      {detail ? (
        <div className="subagent-facts" aria-label="分身运行信息">
          <span>{PROFILE_LABELS[detail.node.profile]}</span>
          <span>深度 {detail.node.depth}</span>
          <span>{currentAttempt?.modelId ?? '未分配模型'}</span>
        </div>
      ) : null}

      {currentAttempt ? <AgentUsageSummary usage={currentAttempt.usage} /> : null}

      {artifacts.length > 0 ? <ArtifactBrowser artifacts={artifacts} /> : null}

      <div className="subagent-event-filters" role="toolbar" aria-label="筛选执行记录">
        {EVENT_FILTERS.map((filter) => (
          <button
            type="button"
            key={filter.value}
            aria-pressed={eventFilter === filter.value}
            onClick={() => setEventFilter(filter.value)}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <div className="subagent-event-log" aria-live="polite">
        {detailLoading && filteredDisplayEvents.length === 0 ? (
          <div className="subagent-loading"><LoaderCircle className="subagent-spin" size={18} /></div>
        ) : null}
        {filteredDisplayEvents.map((event) => (
          <EventRow
            key={event.key}
            event={event}
            onOpenAgent={(agentId) => onSelectAgent({
              rootRunId: selectedAgent.rootRunId,
              agentId
            })}
          />
        ))}
        {filteredDisplayEvents.length === 0 && !detailLoading ? (
          <div className="subagent-empty">
            <FileText size={21} />
            <span>{displayEvents.length === 0 ? '暂无执行记录' : '此筛选下暂无记录'}</span>
          </div>
        ) : null}
        {eventHasMore ? (
          <button
            type="button"
            className="subagent-load-events"
            disabled={detailLoading}
            onClick={() => void loadMoreEvents()}
          >
            加载后续记录
          </button>
        ) : null}
      </div>

      <div className="subagent-message-composer">
        <textarea
          value={message}
          rows={2}
          maxLength={8_192}
          placeholder={isActive ? '发送补充信息' : '追问此分身'}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submitMessage()
            }
          }}
        />
        <button
          type="button"
          title={isActive ? '发送消息' : '发起追问'}
          aria-label={isActive ? '发送消息' : '发起追问'}
          disabled={!message.trim() || actionPending || !detail}
          onClick={submitMessage}
        >
          {actionPending
            ? <LoaderCircle className="subagent-spin" size={16} aria-hidden="true" />
            : <Send size={16} aria-hidden="true" />}
        </button>
      </div>
    </div>
  )
}

function AgentUsageSummary({ usage }: { usage: AgentUsage }): React.ReactElement {
  const facts = [
    ['输入 token', formatTokens(usage.inputTokens)],
    ['输出 token', formatTokens(usage.outputTokens)],
    ['Provider 费用', formatProviderCost(usage.providerCostMicros)],
    ['工具调用', formatCount(usage.toolCalls)],
    ['命令用时', formatDuration(usage.commandWallTimeMs)],
    ['总用时', formatDuration(usage.wallTimeMs)],
    ['读取文件', formatCount(usage.filesRead)],
    ['写入文件', formatCount(usage.filesWritten)],
    ['工具结果', formatBytes(usage.modelVisibleToolResultBytes)],
    ['子智能体', formatCount(usage.childAgents)]
  ] as const

  return (
    <dl className="subagent-usage" aria-label="分身资源用量">
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

interface AgentListSectionProps {
  title: string
  agents: AgentSummary[]
  emptyText: string
  titlesByAgentId: Map<string, string>
  onSelectAgent: (agent: SelectedSubAgent) => void
}

function AgentListSection({
  title,
  agents,
  emptyText,
  titlesByAgentId,
  onSelectAgent
}: AgentListSectionProps): React.ReactElement {
  return (
    <section className="subagent-list-section" aria-label={title}>
      <h3>{title}</h3>
      <div role="list">
        {agents.map((agent) => (
          <AgentListItem
            key={`${agent.rootRunId}:${agent.agentId}`}
            agent={agent}
            parentTitle={agent.parentAgentId
              ? titlesByAgentId.get(agent.parentAgentId)
              : undefined}
            onSelect={() => onSelectAgent({
              rootRunId: agent.rootRunId,
              agentId: agent.agentId
            })}
          />
        ))}
        {agents.length === 0 ? (
          <div className="subagent-section-empty">
            <Bot size={15} aria-hidden="true" />
            <span>{emptyText}</span>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function AgentListItem({
  agent,
  parentTitle,
  onSelect
}: {
  agent: AgentSummary
  parentTitle?: string
  onSelect: () => void
}): React.ReactElement {
  const origin = agent.depth > 1
    ? ` · 由${parentTitle ?? '上级分身'}创建`
    : ''
  return (
    <button
      type="button"
      role="listitem"
      className="subagent-list-item"
      onClick={onSelect}
    >
      <StateGlyph state={agent.state} />
      <span className="subagent-list-copy">
        <span className="subagent-list-title">{agent.title}</span>
        <span className="subagent-list-summary">{agent.latestSummary}</span>
        <span className="subagent-list-meta">
          {PROFILE_LABELS[agent.profile]} · 深度 {agent.depth}{origin}
        </span>
      </span>
      <span className="subagent-list-side">
        <span className={`subagent-state subagent-state--${stateTone(agent.state)}`}>
          {STATE_LABELS[agent.state]}
        </span>
        <time dateTime={agent.finishedAt ?? agent.updatedAt}>
          {formatRelativeTime(agent.finishedAt ?? agent.updatedAt)}
        </time>
      </span>
    </button>
  )
}

function ArtifactBrowser({ artifacts }: { artifacts: AgentArtifact[] }): React.ReactElement {
  return (
    <section className="subagent-artifacts" aria-label="分身产物">
      <header><FileText size={13} aria-hidden="true" /><span>产物</span></header>
      {artifacts.map((artifact) => (
        <details key={artifact.artifactId}>
          <summary>
            <span>{artifact.name}</span>
            <small>{formatBytes(artifact.sizeBytes)}</small>
          </summary>
          <div className="subagent-artifact-meta" title={artifact.path}>
            <code>{artifact.sha256}</code>
          </div>
          {artifact.preview
            ? <pre>{artifact.preview}{artifact.previewTruncated ? '\n…' : ''}</pre>
            : <p>二进制产物</p>}
        </details>
      ))}
    </section>
  )
}

function EventRow({
  event,
  onOpenAgent
}: {
  event: DisplayEvent
  onOpenAgent?: (agentId: string) => void
}): React.ReactElement {
  const Icon = event.kind === 'reasoningDelta'
    ? Brain
    : event.kind === 'toolStarted' || event.kind === 'toolCompleted' || event.kind === 'toolUpdated'
      ? Wrench
      : event.kind === 'agentMessageReceived' || event.kind === 'agentMessageSent'
        ? MessageSquareMore
        : event.kind === 'errorRaised'
          ? AlertCircle
          : event.kind === 'stateChanged' || event.kind === 'resultSubmitted'
            ? Check
            : FileText
  return (
    <article className={`subagent-event subagent-event--${eventTone(event.kind)}`}>
      <div className="subagent-event-rail"><Icon size={13} aria-hidden="true" /></div>
      <div className="subagent-event-content">
        <header>
          <span>{event.title}</span>
          <time>{formatTime(event.occurredAt)}</time>
        </header>
        {event.body ? <pre>{event.body}</pre> : null}
        {event.agentHandles?.map((handle) => (
          <button
            type="button"
            className="subagent-child-marker"
            key={handle.agentId}
            onClick={() => onOpenAgent?.(handle.agentId)}
          >
            <Bot size={13} aria-hidden="true" />
            <span>子智能体 {shortAgentId(handle.agentId)}</span>
            <small>{handle.state ? STATE_LABELS[handle.state] : '已创建'}</small>
            <ChevronRight size={13} aria-hidden="true" />
          </button>
        ))}
      </div>
    </article>
  )
}

function InlineError({ message }: { message: string }): React.ReactElement {
  return <div className="subagent-error"><AlertCircle size={14} />{message}</div>
}

function StateGlyph({ state }: { state: AgentState }): React.ReactElement {
  if (state === 'completed') return <Check className="subagent-glyph subagent-glyph--success" size={16} />
  if (state === 'failed' || state === 'blocked') return <AlertCircle className="subagent-glyph subagent-glyph--danger" size={16} />
  if (ACTIVE_STATES.has(state)) return <LoaderCircle className="subagent-glyph subagent-spin" size={16} />
  return <CircleStop className="subagent-glyph" size={16} />
}

function updateAgentSummary(
  agents: AgentSummary[],
  event: AgentUiEventEnvelope
): AgentSummary[] {
  let matched = false
  const updated = agents.map((agent) => {
    if (agent.agentId !== event.agentId || agent.rootRunId !== event.rootRunId) return agent
    matched = true
    if (event.stateRevision < agent.stateRevision) return agent
    if (event.kind === 'stateChanged') {
      return {
        ...agent,
        attemptId: event.attemptId,
        state: event.payload.next,
        stateRevision: event.stateRevision,
        updatedAt: event.occurredAt
      }
    }
    if (event.kind === 'resultSubmitted') {
      return { ...agent, latestSummary: event.payload.summary, updatedAt: event.occurredAt }
    }
    return agent
  })
  return matched ? updated : agents
}

function mergeAgents(current: AgentSummary[], next: AgentSummary[]): AgentSummary[] {
  const byId = new Map(current.map((agent) => [`${agent.rootRunId}:${agent.agentId}`, agent]))
  for (const agent of next) byId.set(`${agent.rootRunId}:${agent.agentId}`, agent)
  return Array.from(byId.values())
}

function compareAgentActivity(left: AgentSummary, right: AgentSummary): number {
  const leftTime = Date.parse(left.finishedAt ?? left.updatedAt)
  const rightTime = Date.parse(right.finishedAt ?? right.updatedAt)
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime
  }
  return left.agentId.localeCompare(right.agentId)
}

function appendEvent(
  current: AgentUiEventEnvelope[],
  event: AgentUiEventEnvelope
): AgentUiEventEnvelope[] {
  if (current.some((item) => item.sequence === event.sequence)) return current
  const next = [...current, event].sort((left, right) => left.sequence - right.sequence)
  return next.length > MAX_CACHED_EVENTS ? next.slice(-MAX_CACHED_EVENTS) : next
}

function mergeEvents(
  current: AgentUiEventEnvelope[],
  next: AgentUiEventEnvelope[]
): AgentUiEventEnvelope[] {
  let merged = current
  for (const event of next) merged = appendEvent(merged, event)
  return merged
}

function buildDisplayEvents(events: AgentUiEventEnvelope[]): DisplayEvent[] {
  const output: DisplayEvent[] = []
  for (const event of events) {
    if (event.kind === 'assistantDelta' || event.kind === 'reasoningDelta') {
      const last = output[output.length - 1]
      if (last?.kind === event.kind) {
        last.body += event.payload.delta
        last.key = `${last.key}:${event.sequence}`
        continue
      }
    }
    output.push(displayEvent(event))
  }
  return output
}

function eventMatchesFilter(event: DisplayEvent, filter: EventFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'errors') {
    return event.kind === 'errorRaised'
      || event.kind === 'contextCompactionFailed'
      || event.status === 'failed'
      || event.status === 'error'
  }
  if (filter === 'output') {
    return event.kind === 'assistantDelta'
      || event.kind === 'reasoningDelta'
      || event.kind === 'resultSubmitted'
  }
  if (filter === 'tools') {
    return event.kind === 'toolStarted'
      || event.kind === 'toolUpdated'
      || event.kind === 'toolCompleted'
      || event.kind === 'fileChanged'
      || event.kind === 'permissionRequested'
      || event.kind === 'permissionResolved'
  }
  return event.kind === 'agentMessageReceived' || event.kind === 'agentMessageSent'
}

function displayEvent(event: AgentUiEventEnvelope): DisplayEvent {
  switch (event.kind) {
    case 'assistantDelta':
      return baseDisplay(event, '模型输出', event.payload.delta)
    case 'reasoningDelta':
      return baseDisplay(event, '推理摘要', event.payload.delta)
    case 'toolStarted':
      return baseDisplay(event, event.payload.name, event.payload.summary, 'running')
    case 'toolUpdated':
      return baseDisplay(event, '工具更新', event.payload.summary)
    case 'toolCompleted':
      return completedToolDisplay(event)
    case 'fileChanged':
      return baseDisplay(event, '文件变更', event.payload.path)
    case 'agentMessageSent':
      return baseDisplay(event, '已发送消息', event.payload.summary)
    case 'agentMessageReceived':
      return baseDisplay(event, '收到消息', event.payload.summary)
    case 'permissionRequested':
      return baseDisplay(event, '等待批准', event.payload.summary)
    case 'permissionResolved':
      return baseDisplay(event, '批准结果', event.payload.approved ? '已批准' : '已拒绝')
    case 'providerRetryScheduled':
      return baseDisplay(
        event,
        'Provider 重试',
        `${event.payload.reason} · ${event.payload.attempt}/${event.payload.max_attempts} · ${event.payload.delay_ms} ms`,
        'running'
      )
    case 'contextCompactionStarted':
      return baseDisplay(event, '上下文压缩', `开始 · 版本 ${event.payload.history_version}`, 'running')
    case 'contextCompactionCompleted':
      return baseDisplay(
        event,
        '上下文压缩',
        `${event.payload.tokens_before ?? '?'} → ${event.payload.tokens_after ?? '?'} tokens`,
        'completed'
      )
    case 'contextCompactionFailed':
      return baseDisplay(event, event.payload.code, event.payload.message, 'failed')
    case 'budgetUpdated':
      return baseDisplay(
        event,
        '用量更新',
        `${formatTokens(event.payload.usage.inputTokens)} 输入 · ${formatTokens(event.payload.usage.outputTokens)} 输出`
      )
    case 'stateChanged':
      return baseDisplay(
        event,
        '状态变更',
        `${STATE_LABELS[event.payload.previous]} → ${STATE_LABELS[event.payload.next]}`
      )
    case 'resultSubmitted':
      return baseDisplay(event, '提交结果', event.payload.summary, event.payload.status)
    case 'errorRaised':
      return baseDisplay(event, event.payload.code, event.payload.message, 'failed')
  }
}

function completedToolDisplay(
  event: Extract<AgentUiEventEnvelope, { kind: 'toolCompleted' }>
): DisplayEvent {
  const agentHandles = spawnedAgentHandles(event.payload.name, event.payload.summary)
  return {
    ...baseDisplay(
      event,
      event.payload.name,
      agentHandles.length > 0 ? '' : event.payload.summary,
      event.payload.status
    ),
    agentHandles: agentHandles.length > 0 ? agentHandles : undefined
  }
}

function spawnedAgentHandles(name: string, summary: string): SpawnedAgentHandle[] {
  if (name !== 'spawn_agent' && name !== 'spawn_agents' && name !== 'review_agent') return []
  try {
    const parsed: unknown = JSON.parse(summary)
    const candidates = name === 'spawn_agents'
      ? parsed
      : name === 'review_agent' && isRecord(parsed)
        ? [parsed.reviewer]
        : [parsed]
    if (!Array.isArray(candidates)) return []
    return candidates.flatMap((candidate) => {
      if (!isRecord(candidate) || typeof candidate.agentId !== 'string') return []
      const state = typeof candidate.state === 'string' && candidate.state in STATE_LABELS
        ? candidate.state as AgentState
        : undefined
      return [{ agentId: candidate.agentId, state }]
    })
  } catch {
    return []
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function shortAgentId(agentId: string): string {
  return agentId.length <= 18 ? agentId : `${agentId.slice(0, 9)}…${agentId.slice(-6)}`
}

function baseDisplay(
  event: AgentUiEventEnvelope,
  title: string,
  body: string,
  status?: string
): DisplayEvent {
  return {
    key: `${event.attemptId}:${event.sequence}`,
    kind: event.kind,
    occurredAt: event.occurredAt,
    title,
    body,
    status
  }
}

function stateTone(state: AgentState): 'active' | 'success' | 'danger' | 'muted' {
  if (ACTIVE_STATES.has(state)) return 'active'
  if (state === 'completed') return 'success'
  if (state === 'failed' || state === 'blocked') return 'danger'
  return 'muted'
}

function eventTone(kind: AgentUiEventEnvelope['kind']): string {
  if (kind === 'errorRaised' || kind === 'contextCompactionFailed') return 'danger'
  if (kind === 'reasoningDelta') return 'reasoning'
  if (kind === 'toolStarted' || kind === 'toolUpdated' || kind === 'toolCompleted') return 'tool'
  if (kind === 'providerRetryScheduled' || kind === 'contextCompactionStarted' || kind === 'contextCompactionCompleted') return 'state'
  if (kind === 'agentMessageReceived' || kind === 'agentMessageSent') return 'message'
  if (kind === 'stateChanged' || kind === 'resultSubmitted') return 'state'
  return 'text'
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value)
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatProviderCost(value: number): string {
  if (value === 0) return '$0'
  const cost = value / 1_000_000
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${value} ms`
  const seconds = value / 1_000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`
  const wholeMinutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  if (wholeMinutes < 60) return `${wholeMinutes} 分 ${remainingSeconds} 秒`
  const hours = Math.floor(wholeMinutes / 60)
  return `${hours} 小时 ${wholeMinutes % 60} 分`
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`
  return `${(value / 1_048_576).toFixed(1)} MB`
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(date)
}

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return value
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000))
  if (elapsedSeconds < 60) return '刚刚'
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours} 小时前`
  const elapsedDays = Math.floor(elapsedHours / 24)
  if (elapsedDays < 7) return `${elapsedDays} 天前`
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric'
  }).format(new Date(timestamp))
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
