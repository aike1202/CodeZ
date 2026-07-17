import type {
  AgentRecord,
  AgentRuntimeSnapshot
} from '../shared/desktop/generated/contracts'
import type {
  NormalizedModelMessage,
  SessionRuntimeScopeSnapshot
} from '@shared/types/context'
import type {
  ChatMessage,
  ExecutionTimelineItem,
  SubAgentRecord,
  ToolCallState
} from '../stores/chatStore'

const RUNTIME_PARENT_PREFIX = 'runtime:'

interface SpawnLocation {
  messageId: string
  toolCall: ToolCallState
  agentId?: string
  taskName?: string
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function stringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = (value as Record<string, unknown>)[field]
  return typeof candidate === 'string' ? candidate : undefined
}

function agentIdFromResult(result: string | undefined): string | undefined {
  let value = parseJson(result)
  for (let depth = 0; depth < 4 && value; depth += 1) {
    const direct = stringField(value, 'agentId')
    if (direct) return direct
    if (typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    const agent = record.agent
    const nested = stringField(agent, 'agentId')
    if (nested) return nested
    value = typeof record.data === 'string' ? parseJson(record.data) : record.data
  }
  return undefined
}

function toolCallsForMessage(message: ChatMessage): ToolCallState[] {
  const calls = new Map<string, ToolCallState>()
  for (const call of message.toolCalls ?? []) calls.set(call.id, call)
  for (const item of message.executionTimeline ?? []) {
    if (item.type === 'tool') calls.set(item.toolCall.id, item.toolCall)
  }
  return [...calls.values()]
}

function spawnLocations(messages: ChatMessage[]): SpawnLocation[] {
  return messages.flatMap((message) => toolCallsForMessage(message)
    .filter((toolCall) => toolCall.name === 'spawn_agent')
    .map((toolCall) => {
      const args = parseJson(toolCall.args)
      return {
        messageId: message.id,
        toolCall,
        agentId: agentIdFromResult(toolCall.result),
        taskName: stringField(args, 'taskName') ?? stringField(args, 'task_name')
      }
    }))
}

function timestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function mailboxPrompt(snapshot: AgentRuntimeSnapshot, agent: AgentRecord): string {
  return snapshot.messages.find((message) =>
    message.attemptId === agent.attemptId && message.messageType === 'NEW_TASK'
  )?.payload ?? agent.description
}

function runtimeRecord(
  snapshot: AgentRuntimeSnapshot,
  agent: AgentRecord,
  parentToolCallId: string,
  existing?: SubAgentRecord
): SubAgentRecord {
  const startedAt = timestamp(agent.startedAt ?? agent.createdAt, Date.now())
  const completedAt = agent.completedAt ? timestamp(agent.completedAt, startedAt) : undefined
  const status = agent.status === 'queued' ? 'running' : agent.status
  const report = agent.result?.report
  return {
    ...existing,
    id: agent.agentId,
    sessionId: agent.sessionId,
    contextScopeId: agent.contextScopeId,
    attemptId: agent.attemptId,
    type: agent.role,
    description: agent.description,
    prompt: mailboxPrompt(snapshot, agent),
    depth: agent.launch.depth,
    expectations: agent.launch.expectations
      ? {
          questions: agent.launch.expectations.questions,
          outOfScope: agent.launch.expectations.outOfScope
        }
      : undefined,
    context: agent.launch.context,
    scope: agent.launch.scope
      ? {
          directories: agent.launch.scope.directories,
          excludeGlobs: agent.launch.scope.excludeGlobs
        }
      : undefined,
    parentToolCallId,
    status,
    startedAt,
    completedAt,
    content: report ?? existing?.content ?? '',
    reasoningContent: existing?.reasoningContent,
    toolCalls: existing?.toolCalls ?? [],
    executionTimeline: existing?.executionTimeline ?? [],
    result: agent.result
      ? {
          ...existing?.result,
          output: report,
          toolCallCount: existing?.result?.toolCallCount ?? existing?.toolCalls.length ?? 0,
          conclusion: agent.result.conclusion
        }
      : existing?.result
  }
}

/** Merges authoritative collaboration runtime records into the chat messages that spawned them. */
export function mergeRuntimeSubAgents(
  messages: ChatMessage[],
  snapshot: AgentRuntimeSnapshot | undefined
): ChatMessage[] {
  if (!snapshot?.agents.length || !messages.length) return messages

  const locations = spawnLocations(messages)
  const existingLocations = new Map<string, { messageId: string, record: SubAgentRecord }>()
  for (const message of messages) {
    for (const record of message.subAgents ?? []) {
      existingLocations.set(record.id, { messageId: message.id, record })
    }
  }

  const additions = new Map<string, SubAgentRecord[]>()
  const claimedCalls = new Set<string>()
  for (const agent of snapshot.agents) {
    if (agent.parentAgentId !== '/root') continue
    const existing = existingLocations.get(agent.agentId)
    const exact = locations.find((location) => location.agentId === agent.agentId)
    const byTask = locations.find((location) =>
      !claimedCalls.has(location.toolCall.id) && location.taskName === agent.taskName
    )
    const location = exact ?? byTask
    if (location) claimedCalls.add(location.toolCall.id)
    const messageId = existing?.messageId ?? location?.messageId ?? messages.at(-1)?.id
    if (!messageId) continue
    const record = runtimeRecord(
      snapshot,
      agent,
      existing?.record.parentToolCallId
        ?? location?.toolCall.id
        ?? `${RUNTIME_PARENT_PREFIX}${agent.agentId}`,
      existing?.record
    )
    const records = additions.get(messageId) ?? []
    records.push(record)
    additions.set(messageId, records)
  }

  if (!additions.size) return messages
  return messages.map((message) => {
    const runtimeRecords = additions.get(message.id)
    if (!runtimeRecords) return message
    const merged = new Map((message.subAgents ?? []).map((record) => [record.id, record]))
    for (const record of runtimeRecords) merged.set(record.id, record)
    return { ...message, subAgents: [...merged.values()] }
  })
}

function toolResultIsError(message: NormalizedModelMessage | undefined): boolean {
  if (!message) return false
  return message.status === 'interrupted'
    || message.content.startsWith('Error:')
    || message.content.includes('"ok":false')
}

/** Projects the durable subagent ledger into the existing card timeline model. */
export function hydrateSubAgentFromLedger(
  subAgent: SubAgentRecord,
  scope: SessionRuntimeScopeSnapshot | undefined
): SubAgentRecord {
  if (!scope) return subAgent
  const messages = scope.activeMessages
  const results = new Map(messages
    .filter((message) => message.role === 'tool' && message.toolCallId)
    .map((message) => [message.toolCallId as string, message]))
  const toolCalls: ToolCallState[] = []
  const executionTimeline: ExecutionTimelineItem[] = []
  const assistantContent: string[] = []
  let sequence = 0

  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const createdAt = timestamp(message.createdAt, subAgent.startedAt)
    if (message.content.trim()) {
      assistantContent.push(message.content.trim())
      executionTimeline.push({
        id: `${message.id}:text`,
        type: 'text',
        content: message.content,
        status: 'success',
        startedAt: createdAt,
        updatedAt: createdAt,
        completedAt: createdAt,
        sequence: sequence++
      })
    }
    for (const call of message.toolCalls ?? []) {
      const result = results.get(call.id)
      const completedAt = result ? timestamp(result.createdAt, createdAt) : undefined
      const toolCall: ToolCallState = {
        id: call.id,
        name: call.name,
        args: call.arguments,
        status: result ? (toolResultIsError(result) ? 'error' : 'success') : 'running',
        result: result?.content,
        startedAt: createdAt,
        completedAt,
        sequence,
        thoughtSignature: call.thoughtSignature
      }
      toolCalls.push(toolCall)
      executionTimeline.push({
        id: `${message.id}:tool:${call.id}`,
        type: 'tool',
        toolCall,
        startedAt: createdAt,
        updatedAt: completedAt ?? createdAt,
        sequence: sequence++
      })
    }
  }

  return {
    ...subAgent,
    content: subAgent.result?.output
      ?? (assistantContent.length ? assistantContent.join('\n\n') : subAgent.content),
    toolCalls,
    executionTimeline,
    result: subAgent.result
      ? { ...subAgent.result, toolCallCount: toolCalls.length }
      : subAgent.result
  }
}

export function isRuntimeFallbackParent(parentToolCallId: string): boolean {
  return parentToolCallId.startsWith(RUNTIME_PARENT_PREFIX)
}
