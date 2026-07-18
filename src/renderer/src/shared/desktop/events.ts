import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type {
  AgentUpdatedEvent,
  DesktopEvent,
  SubAgentRunState,
  TodoUpdatedEvent,
  ThemeInfo
} from './generated/contracts'

const THEME_CHANGED_EVENT = 'desktop://theme-changed'
const TODO_UPDATED_EVENT = 'todo:updated'
const AGENT_UPDATED_EVENT = 'agent:updated'
const SUBAGENT_STATE_EVENT = 'subagent:state'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function isTodoUpdatedEvent(value: unknown): value is TodoUpdatedEvent {
  if (!isRecord(value) || !isRecord(value.snapshot)) return false
  return value.version === 1
    && typeof value.sessionId === 'string'
    && value.sessionId.length > 0
    && isNonNegativeInteger(value.revision)
    && value.snapshot.version === 2
    && value.snapshot.sessionId === value.sessionId
    && value.snapshot.revision === value.revision
    && isNonNegativeInteger(value.snapshot.nextSequence)
    && Array.isArray(value.snapshot.items)
    && Array.isArray(value.snapshot.archivedItems)
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

export interface DesktopEvents {
  theme: {
    onChanged(callback: (event: DesktopEvent<ThemeInfo>) => void): Promise<UnlistenFn>
  }
  todo: {
    onUpdated(callback: (event: TodoUpdatedEvent) => void): Promise<UnlistenFn>
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
  todo: {
    onUpdated: async (callback) => {
      return listen<unknown>(TODO_UPDATED_EVENT, (event) => {
        if (isTodoUpdatedEvent(event.payload)) callback(event.payload)
      })
    }
  },
  agent: {
    onUpdated: async (callback) => {
      return listen<unknown>(AGENT_UPDATED_EVENT, (event) => {
        if (isAgentUpdatedEvent(event.payload)) callback(event.payload)
      })
    }
  },
  subAgent: {
    onState: async (callback) => {
      return listen<unknown>(SUBAGENT_STATE_EVENT, (event) => {
        if (isSubAgentRunState(event.payload)) callback(event.payload)
      })
    }
  }
}
