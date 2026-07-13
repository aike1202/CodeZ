import { createHash } from 'crypto'
import type {
  NormalizedModelMessage,
  PostCompactionSkillContext,
  SessionSkillState
} from '../../../shared/types/context'

const ACTIVATION_TOOLS = new Set(['Skill', 'ActivateSkill'])
const DEACTIVATION_TOOL = 'DeactivateSkill'

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase()
}

function cloneState(state: SessionSkillState): SessionSkillState {
  return { ...state }
}

function unwrapSuccessfulToolData(message: NormalizedModelMessage): string | undefined {
  if (message.role !== 'tool' || message.status !== 'complete') return undefined
  try {
    const wrapper = JSON.parse(message.content)
    return wrapper?.ok === true && typeof wrapper.data === 'string'
      ? wrapper.data
      : undefined
  } catch {
    return message.content.startsWith('Error:') ? undefined : message.content
  }
}

function findToolInput(
  messages: readonly NormalizedModelMessage[],
  result: NormalizedModelMessage
): { skill?: string; args?: string; mode?: string; reason?: string } {
  if (!result.toolCallId) return {}
  for (let index = messages.length - 1; index >= 0; index--) {
    const call = messages[index].toolCalls?.find((candidate) => candidate.id === result.toolCallId)
    if (!call) continue
    try {
      const parsed = JSON.parse(call.arguments)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

function commandName(content: string, fallback: string): string {
  const match = content.match(/^<command-name>([^\r\n<]*)<\/command-name>/)
  if (!match?.[1]) return fallback
  return match[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function stateMarker(content: string): {
  status?: string
  skill?: string
  reason?: string
} | undefined {
  try {
    const parsed = JSON.parse(content)
    return parsed?.type === 'skill_state' ? parsed : undefined
  } catch {
    return undefined
  }
}

function explicitSkillState(message: NormalizedModelMessage): SessionSkillState | undefined {
  if (message.role !== 'user') return undefined
  const nameMatch = message.content.match(/^【本次请求强制应用工作流：([^】]+)】/)
  if (!nameMatch?.[1]) return undefined
  const bodyMatch = message.content.match(/指令要求如下：\n([\s\S]*?)\n\n当前任务参数\/问题：\n([\s\S]*)$/)
  const content = bodyMatch?.[1]?.trim() || message.content
  const args = bodyMatch?.[2]?.trim() || ''
  return {
    name: nameMatch[1].trim(),
    status: 'active',
    content,
    contentHash: hashSkillContent(content),
    args,
    source: 'user',
    updatedAt: message.createdAt,
    updatedSequence: message.sourceSequence ?? 0
  }
}

function toolSkillState(
  messages: readonly NormalizedModelMessage[],
  message: NormalizedModelMessage
): SessionSkillState | undefined {
  if (!message.name || (!ACTIVATION_TOOLS.has(message.name) && message.name !== DEACTIVATION_TOOL)) {
    return undefined
  }
  const content = unwrapSuccessfulToolData(message)
  if (!content) return undefined
  const input = findToolInput(messages, message)
  const marker = stateMarker(content)
  if (marker?.status === 'already_active') return undefined

  if (message.name === DEACTIVATION_TOOL) {
    const name = marker?.skill || input.skill
    const status = marker?.status === 'disabled' ? 'disabled' : 'inactive'
    if (!name) return undefined
    return {
      name,
      status,
      source: 'model',
      reason: marker?.reason || input.reason,
      updatedAt: message.createdAt,
      updatedSequence: message.sourceSequence ?? 0
    }
  }

  const fallbackName = typeof input.skill === 'string' ? input.skill : message.name
  const name = commandName(content, fallbackName)
  return {
    name,
    status: 'active',
    content,
    contentHash: hashSkillContent(content),
    args: typeof input.args === 'string' ? input.args : '',
    source: 'model',
    updatedAt: message.createdAt,
    updatedSequence: message.sourceSequence ?? 0
  }
}

export function hashSkillContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function isSkillActivationTool(name?: string): boolean {
  return Boolean(name && ACTIVATION_TOOLS.has(name))
}

export function findSessionSkillState(
  states: readonly SessionSkillState[] | undefined,
  name: string
): SessionSkillState | undefined {
  const key = normalizedName(name)
  return states?.find((state) => normalizedName(state.name) === key)
}

export function upsertSessionSkillState(
  states: readonly SessionSkillState[] | undefined,
  next: SessionSkillState
): SessionSkillState[] {
  const key = normalizedName(next.name)
  const result = (states || [])
    .filter((state) => normalizedName(state.name) !== key)
    .map(cloneState)
  result.push(cloneState(next))
  return result.sort((left, right) => left.updatedSequence - right.updatedSequence)
}

export function applyMessageToSessionSkillStates(
  states: readonly SessionSkillState[] | undefined,
  messages: readonly NormalizedModelMessage[],
  message: NormalizedModelMessage
): SessionSkillState[] {
  const next = explicitSkillState(message) || toolSkillState(messages, message)
  return next ? upsertSessionSkillState(states, next) : (states || []).map(cloneState)
}

export function deriveSessionSkillStates(input: {
  messages: readonly NormalizedModelMessage[]
  initial?: readonly SessionSkillState[]
  postCompaction?: PostCompactionSkillContext
}): SessionSkillState[] {
  let states = (input.initial || []).map(cloneState)
  if (states.length === 0 && input.postCompaction?.skills.length) {
    states = input.postCompaction.skills.map((skill) => ({
      name: skill.name,
      status: 'active',
      content: skill.content,
      contentHash: hashSkillContent(skill.content),
      args: '',
      source: 'recovery',
      updatedAt: input.postCompaction!.createdAt,
      updatedSequence: skill.invokedSequence
    }))
  }
  const prefix: NormalizedModelMessage[] = []
  for (const message of input.messages) {
    prefix.push(message)
    states = applyMessageToSessionSkillStates(states, prefix, message)
  }
  return states
}

export function renderSessionSkillStateContext(
  states: readonly SessionSkillState[] | undefined
): string {
  if (!states?.length) return ''
  const active = states
    .filter((state) => state.status === 'active')
    .map((state) => ({
      name: state.name,
      args: state.args || '',
      contentHash: state.contentHash,
      source: state.source
    }))
  const inactive = states
    .filter((state) => state.status === 'inactive')
    .map((state) => ({ name: state.name, reason: state.reason }))
  const disabled = states
    .filter((state) => state.status === 'disabled')
    .map((state) => ({ name: state.name, reason: state.reason }))
  return safeJson({
    type: 'session_skill_state',
    notice: 'This state is authoritative for the current conversation. Continue following active skills without activating them again. Do not use inactive skills unless the current request needs them. Never activate a disabled skill unless the user explicitly asks to re-enable it.',
    active,
    inactive,
    disabled
  })
}

export function activeSessionSkillNames(
  states: readonly SessionSkillState[] | undefined
): Set<string> {
  return new Set((states || [])
    .filter((state) => state.status === 'active')
    .map((state) => normalizedName(state.name)))
}
