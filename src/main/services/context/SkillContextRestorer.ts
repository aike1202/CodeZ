import type {
  InvokedSkillContextEntry,
  NormalizedModelMessage,
  PostCompactionSkillContext,
  SessionSkillState
} from '../../../shared/types/context'
import { ContextBudgetService } from './ContextBudgetService'
import { isSkillActivationTool } from './SessionSkillState'

const MAX_TOKENS_PER_SKILL = 5_000
const MAX_TOTAL_TOKENS = 25_000

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export function renderPostCompactionSkillContext(
  skills: readonly InvokedSkillContextEntry[]
): string {
  return safeJson({
    type: 'invoked_skills',
    notice: 'These skills are already loaded. Continue following their content; do not invoke Skill again only to reload them.',
    skills: skills.map((skill) => ({ name: skill.name, content: skill.content }))
  })
}

function contextFromSkills(
  skills: readonly InvokedSkillContextEntry[],
  createdAt = new Date().toISOString(),
  sourceSequence?: number
): PostCompactionSkillContext | undefined {
  if (skills.length === 0) return undefined
  const cloned = skills.map((skill) => ({ ...skill }))
  return {
    content: renderPostCompactionSkillContext(cloned),
    skills: cloned,
    createdAt,
    sourceSequence
  }
}

function successfulToolContent(message: NormalizedModelMessage): string | undefined {
  if (message.role !== 'tool' || !isSkillActivationTool(message.name) || message.status !== 'complete') {
    return undefined
  }
  try {
    const wrapper = JSON.parse(message.content)
    if (wrapper?.ok !== true || typeof wrapper.data !== 'string') return undefined
    try {
      const marker = JSON.parse(wrapper.data)
      if (marker?.type === 'skill_state' && marker?.status === 'already_active') return undefined
    } catch {}
    return wrapper.data
  } catch {
    return message.content.startsWith('Error:') ? undefined : message.content
  }
}

function canonicalSkillName(content: string, fallback: string): string {
  const match = content.match(/^<command-name>([^\r\n<]*)<\/command-name>/)
  return match?.[1]
    ? match[1]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
    : fallback
}

function invokedSkills(
  messages: readonly NormalizedModelMessage[]
): InvokedSkillContextEntry[] {
  const callNames = new Map<string, string>()
  const latest = new Map<string, InvokedSkillContextEntry>()
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    for (const call of message.toolCalls || []) {
      if (!isSkillActivationTool(call.name)) continue
      try {
        const parsed = JSON.parse(call.arguments) as { skill?: unknown }
        if (typeof parsed.skill === 'string' && parsed.skill.trim()) {
          callNames.set(call.id, parsed.skill.trim())
        }
      } catch {}
    }
    const content = successfulToolContent(message)
    const name = message.toolCallId ? callNames.get(message.toolCallId) : undefined
    if (!content || !name) continue
    const resolvedName = canonicalSkillName(content, name)
    latest.set(resolvedName.toLowerCase(), {
      name: resolvedName,
      content,
      invokedSequence: message.sourceSequence ?? index + 1
    })
  }
  return [...latest.values()]
}

function visibleSkillNames(messages: readonly NormalizedModelMessage[]): Set<string> {
  const names = new Set(invokedSkills(messages).map((skill) => skill.name.toLowerCase()))
  for (const message of messages) {
    if (message.role !== 'user') continue
    const match = message.content.match(/^【本次请求强制应用工作流：([^】]+)】/)
    if (match?.[1]) names.add(match[1].trim().toLowerCase())
  }
  return names
}

export class SkillContextRestorer {
  constructor(private readonly budget = new ContextBudgetService()) {}

  reconcile(input: {
    context?: PostCompactionSkillContext
    messages: readonly NormalizedModelMessage[]
    activeSkillNames?: ReadonlySet<string>
    activeSkills?: readonly SessionSkillState[]
  }): PostCompactionSkillContext | undefined {
    const context = input.context
    const newerNames = new Set(invokedSkills(input.messages)
      .filter((skill) =>
        context?.sourceSequence === undefined || skill.invokedSequence > context.sourceSequence
      )
      .map((skill) => skill.name.toLowerCase()))
    const selected = (context?.skills || []).filter((skill) =>
        !newerNames.has(skill.name.toLowerCase()) &&
        (!input.activeSkillNames || input.activeSkillNames.has(skill.name.toLowerCase()))
      )
    const selectedNames = new Set(selected.map((skill) => skill.name.toLowerCase()))
    const visibleNames = visibleSkillNames(input.messages)
    for (const state of [...(input.activeSkills || [])]
      .filter((skill) => skill.status === 'active' && Boolean(skill.content))
      .sort((left, right) => right.updatedSequence - left.updatedSequence)) {
      const name = state.name.toLowerCase()
      if (selectedNames.has(name) || visibleNames.has(name)) continue
      const candidate = {
        name: state.name,
        content: this.truncate(state.content!, MAX_TOKENS_PER_SKILL),
        invokedSequence: state.updatedSequence
      }
      if (this.budget.estimateStringTokens(renderPostCompactionSkillContext([...selected, candidate])) > MAX_TOTAL_TOKENS) {
        continue
      }
      selected.push(candidate)
      selectedNames.add(name)
    }
    return contextFromSkills(
      selected,
      context?.createdAt,
      context?.sourceSequence
    )
  }

  restore(input: {
    messages: readonly NormalizedModelMessage[]
    retainedTail?: readonly NormalizedModelMessage[]
    existing?: PostCompactionSkillContext
    maxTotalTokens?: number
    activeSkillNames?: ReadonlySet<string>
    activeSkills?: readonly SessionSkillState[]
  }): PostCompactionSkillContext | undefined {
    const maxTotalTokens = Math.max(
      0,
      Math.min(MAX_TOTAL_TOKENS, Math.floor(input.maxTotalTokens ?? MAX_TOTAL_TOKENS))
    )
    if (maxTotalTokens === 0) return undefined
    const latest = new Map<string, InvokedSkillContextEntry>()
    for (const skill of input.activeSkills || []) {
      if (skill.status !== 'active' || !skill.content) continue
      latest.set(skill.name.toLowerCase(), {
        name: skill.name,
        content: skill.content,
        invokedSequence: skill.updatedSequence
      })
    }
    for (const skill of input.existing?.skills || []) {
      latest.set(skill.name.toLowerCase(), { ...skill })
    }
    for (const skill of invokedSkills(input.messages)) {
      latest.set(skill.name.toLowerCase(), skill)
    }
    const visibleNames = new Set(invokedSkills(input.retainedTail || [])
      .map((skill) => skill.name.toLowerCase()))

    const selected: InvokedSkillContextEntry[] = []
    for (const skill of [...latest.values()].sort(
      (left, right) => right.invokedSequence - left.invokedSequence
    )) {
      if (input.activeSkillNames && !input.activeSkillNames.has(skill.name.toLowerCase())) continue
      if (visibleNames.has(skill.name.toLowerCase())) continue
      const shellTokens = this.budget.estimateStringTokens(
        renderPostCompactionSkillContext([...selected, { ...skill, content: '' }])
      )
      const availableContentTokens = maxTotalTokens - shellTokens
      if (availableContentTokens <= 0) continue
      const candidate = {
        ...skill,
        content: this.truncate(
          skill.content,
          Math.min(MAX_TOKENS_PER_SKILL, availableContentTokens)
        )
      }
      if (
        this.budget.estimateStringTokens(
          renderPostCompactionSkillContext([...selected, candidate])
        ) <= maxTotalTokens
      ) selected.push(candidate)
    }
    return contextFromSkills(selected)
  }

  private truncate(content: string, maxTokens: number): string {
    if (this.budget.estimateStringTokens(content) <= maxTokens) return content
    const marker = '\n\n[Skill content truncated after compaction]'
    let low = 0
    let high = content.length
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = `${content.slice(0, middle)}${marker}`
      if (this.budget.estimateStringTokens(candidate) <= maxTokens) low = middle + 1
      else high = middle - 1
    }
    let end = Math.max(0, high)
    if (end > 0) {
      const finalCodeUnit = content.charCodeAt(end - 1)
      if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) end--
    }
    return `${content.slice(0, end)}${marker}`
  }
}
