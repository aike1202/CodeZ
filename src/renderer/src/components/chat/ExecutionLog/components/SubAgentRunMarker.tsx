import React, { useEffect, useRef, useState } from 'react'
import { AlertCircle, Bot, Check, ChevronRight, LoaderCircle } from 'lucide-react'
import type { AgentState } from '../../../../shared/desktop/generated/contracts'
import { desktopApi } from '../../../../shared/desktop'
import type { UnifiedTimelineItem } from '../utils'
import './SubAgentRunMarker.css'

interface SpawnHandle {
  agentId: string
  attemptId: string
  state: AgentState
}

interface SpawnMarker {
  key: string
  title: string
  handle?: SpawnHandle
}

interface SubAgentRunMarkerProps {
  item: UnifiedTimelineItem
  sessionId: string | null
  onOpenSubAgent?: (agentId: string) => void
}

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

export function isSubAgentSpawnItem(item: UnifiedTimelineItem): boolean {
  return item.toolName === 'spawn_agent' || item.toolName === 'spawn_agents'
}

export default function SubAgentRunMarker({
  item,
  sessionId,
  onOpenSubAgent
}: SubAgentRunMarkerProps): React.ReactElement {
  const markers = spawnMarkers(item)
  return (
    <div className="subagent-run-markers">
      {markers.map((marker) => (
        <SubAgentRunMarkerRow
          key={marker.key}
          marker={marker}
          sessionId={sessionId}
          onOpenSubAgent={onOpenSubAgent}
        />
      ))}
    </div>
  )
}

function SubAgentRunMarkerRow({
  marker,
  sessionId,
  onOpenSubAgent
}: {
  marker: SpawnMarker
  sessionId: string | null
  onOpenSubAgent?: (agentId: string) => void
}): React.ReactElement {
  const [state, setState] = useState<AgentState>(marker.handle?.state ?? 'starting')
  const revisionRef = useRef(0)
  const agentId = marker.handle?.agentId

  useEffect(() => {
    setState(marker.handle?.state ?? 'starting')
    revisionRef.current = 0
  }, [agentId, marker.handle?.state])

  useEffect(() => {
    if (!agentId) return
    return desktopApi.agent.onUiEvent((event) => {
      if (event.agentId !== agentId || event.stateRevision < revisionRef.current) return
      if (event.kind === 'stateChanged') {
        revisionRef.current = event.stateRevision
        setState(event.payload.next)
      }
    })
  }, [agentId])

  useEffect(() => {
    if (!agentId || !sessionId) return
    void desktopApi.agent.list(sessionId, 0, 100)
      .then((page) => page.agents.find((agent) => agent.agentId === agentId))
      .then((agent) => {
        if (!agent) return
        revisionRef.current = agent.stateRevision
        setState(agent.state)
      })
      .catch(() => undefined)
  }, [agentId, sessionId])

  const active = isActive(state)
  const Icon = active ? LoaderCircle : state === 'completed' ? Check : AlertCircle
  return (
    <button
      type="button"
      className="subagent-run-marker"
      disabled={!agentId || !onOpenSubAgent}
      onClick={() => {
        if (agentId) onOpenSubAgent?.(agentId)
      }}
    >
      <span className="subagent-run-marker-icon">
        <Bot size={15} aria-hidden="true" />
      </span>
      <span className="subagent-run-marker-copy">
        <span>{marker.title}</span>
        <small>{agentId ? shortAgentId(agentId) : '正在注册'}</small>
      </span>
      <span className={`subagent-run-marker-state subagent-run-marker-state--${stateTone(state)}`}>
        <Icon className={active ? 'subagent-run-marker-spin' : ''} size={13} aria-hidden="true" />
        {STATE_LABELS[state]}
      </span>
      {agentId ? <ChevronRight size={14} aria-hidden="true" /> : null}
    </button>
  )
}

function spawnMarkers(item: UnifiedTimelineItem): SpawnMarker[] {
  const assignments = spawnAssignments(item.toolName, item.args)
  const handles = spawnHandles(item.detail)
  const count = Math.max(assignments.length, handles.length, 1)
  return Array.from({ length: count }, (_, index) => ({
    key: handles[index]?.agentId ?? `${item.id}:${index}`,
    title: assignments[index] ?? (count > 1 ? `分身 ${index + 1}` : '分身任务'),
    handle: handles[index]
  }))
}

function spawnAssignments(toolName: string | undefined, raw: string | undefined): string[] {
  const value = parseJson(raw)
  if (!value) return []
  const assignments: unknown[] = toolName === 'spawn_agents'
    && isRecord(value)
    && Array.isArray(value.agents)
    ? value.agents
    : [value]
  return assignments.map((assignment, index) => {
    if (!isRecord(assignment)) return `分身 ${index + 1}`
    if (typeof assignment.title === 'string' && assignment.title.trim()) return assignment.title
    if (typeof assignment.task === 'string' && assignment.task.trim()) return assignment.task
    return `分身 ${index + 1}`
  })
}

function spawnHandles(raw: string | undefined): SpawnHandle[] {
  const value = parseJson(raw)
  if (!value) return []
  const candidates = Array.isArray(value) ? value : [value]
  return candidates.flatMap((candidate) => {
    if (
      !isRecord(candidate)
      || typeof candidate.agentId !== 'string'
      || typeof candidate.attemptId !== 'string'
      || typeof candidate.state !== 'string'
    ) return []
    return [{
      agentId: candidate.agentId,
      attemptId: candidate.attemptId,
      state: candidate.state as AgentState
    }]
  })
}

function parseJson(raw: string | undefined): Record<string, unknown> | unknown[] | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    return isRecord(value) || Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isActive(state: AgentState): boolean {
  return [
    'created', 'queued', 'starting', 'running', 'waiting_message', 'waiting_children',
    'awaiting_approval', 'needs_replan', 'needs_resolution'
  ].includes(state)
}

function stateTone(state: AgentState): 'active' | 'success' | 'danger' | 'muted' {
  if (isActive(state)) return 'active'
  if (state === 'completed') return 'success'
  if (state === 'failed' || state === 'blocked') return 'danger'
  return 'muted'
}

function shortAgentId(agentId: string): string {
  return agentId.length <= 18 ? agentId : `${agentId.slice(0, 9)}…${agentId.slice(-6)}`
}
