import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type {
  AgentUpdatedEvent,
  DesktopEvent,
  SubAgentRunState,
  TaskItem,
  TaskUpdatedEvent,
  ThemeInfo
} from './generated/contracts'

const THEME_CHANGED_EVENT = 'desktop://theme-changed'
const TASK_UPDATED_EVENT = 'task:updated'
const AGENT_UPDATED_EVENT = 'agent:updated'
const SUBAGENT_STATE_EVENT = 'subagent:state'

const legacyTaskRevisions = new Map<string, number>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return true
  if ('__TAURI_INTERNALS__' in window) return true
  return !(window as unknown as { api?: Window['api'] }).api
}

export function isTaskUpdatedEvent(value: unknown): value is TaskUpdatedEvent {
  if (!isRecord(value) || !isRecord(value.snapshot)) return false
  return value.version === 1
    && typeof value.sessionId === 'string'
    && value.sessionId.length > 0
    && isNonNegativeInteger(value.revision)
    && value.snapshot.version === 1
    && value.snapshot.sessionId === value.sessionId
    && value.snapshot.revision === value.revision
    && isNonNegativeInteger(value.snapshot.nextSequence)
    && Array.isArray(value.snapshot.tasks)
}

export function isAgentUpdatedEvent(value: unknown): value is AgentUpdatedEvent {
  if (!isRecord(value) || !isRecord(value.snapshot)) return false
  return value.version === 1
    && typeof value.sessionId === 'string'
    && value.sessionId.length > 0
    && isNonNegativeInteger(value.revision)
    && value.snapshot.version === 1
    && value.snapshot.sessionId === value.sessionId
    && value.snapshot.revision === value.revision
    && Array.isArray(value.snapshot.agents)
    && Array.isArray(value.snapshot.messages)
}

function isSubAgentRunState(value: unknown): value is SubAgentRunState {
  if (!isRecord(value)) return false
  return typeof value.runId === 'string'
    && value.runId.length > 0
    && typeof value.sessionId === 'string'
    && value.sessionId.length > 0
    && ['running', 'completed', 'failed', 'interrupted'].includes(String(value.status))
}

function legacyTaskItems(value: unknown): TaskItem[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).flatMap((item) => {
    if (
      typeof item.id !== 'string'
      || typeof item.subject !== 'string'
      || typeof item.description !== 'string'
      || !['pending', 'in_progress', 'completed', 'cancelled'].includes(String(item.status))
    ) {
      return []
    }
    const requiresApproval = item.requiresApproval === true
    return [{
      ...item,
      requiresApproval,
      approvalStatus: typeof item.approvalStatus === 'string'
        ? item.approvalStatus
        : requiresApproval ? 'pending' : 'not_required'
    } as TaskItem]
  })
}

function legacyTaskListener(callback: (event: TaskUpdatedEvent) => void): UnlistenFn {
  const task = (window as unknown as {
    api?: {
      task?: {
        subscribe?: (
          callback: (payload: { sessionId: string; tasks: unknown[] }) => void
        ) => UnlistenFn
      }
    }
  }).api?.task
  if (!task?.subscribe) return () => undefined
  return task.subscribe((payload) => {
    if (!payload || typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) return
    const revision = (legacyTaskRevisions.get(payload.sessionId) ?? 0) + 1
    legacyTaskRevisions.set(payload.sessionId, revision)
    callback({
      version: 1,
      sessionId: payload.sessionId,
      revision,
      snapshot: {
        version: 1,
        sessionId: payload.sessionId,
        revision,
        nextSequence: 0,
        tasks: legacyTaskItems(payload.tasks)
      }
    })
  })
}

export function getLegacyTaskRevision(sessionId: string): number {
  return legacyTaskRevisions.get(sessionId) ?? 0
}

export interface DesktopEvents {
  theme: {
    onChanged(callback: (event: DesktopEvent<ThemeInfo>) => void): Promise<UnlistenFn>
  }
  task: {
    onUpdated(callback: (event: TaskUpdatedEvent) => void): Promise<UnlistenFn>
  }
  agent: {
    onUpdated(callback: (event: AgentUpdatedEvent) => void): Promise<UnlistenFn>
  }
  subAgent: {
    onState(callback: (state: SubAgentRunState) => void): Promise<UnlistenFn>
  }
}

export const desktopEvents: DesktopEvents = {
  theme: {
    onChanged: async (callback) => {
      return listen<DesktopEvent<ThemeInfo>>(THEME_CHANGED_EVENT, (event) => callback(event.payload))
    }
  },
  task: {
    onUpdated: async (callback) => {
      if (!isTauriRuntime()) return legacyTaskListener(callback)
      return listen<unknown>(TASK_UPDATED_EVENT, (event) => {
        if (isTaskUpdatedEvent(event.payload)) callback(event.payload)
      })
    }
  },
  agent: {
    onUpdated: async (callback) => {
      if (!isTauriRuntime()) return () => undefined
      return listen<unknown>(AGENT_UPDATED_EVENT, (event) => {
        if (isAgentUpdatedEvent(event.payload)) callback(event.payload)
      })
    }
  },
  subAgent: {
    onState: async (callback) => {
      if (!isTauriRuntime()) {
        const subAgent = (window as unknown as { api?: Window['api'] }).api?.subAgent
        return subAgent?.onState(callback) ?? (() => undefined)
      }
      return listen<unknown>(SUBAGENT_STATE_EVENT, (event) => {
        if (isSubAgentRunState(event.payload)) callback(event.payload)
      })
    }
  }
}
