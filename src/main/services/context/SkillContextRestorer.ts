import type {
  InvokedSkillContextEntry,
  NormalizedModelMessage,
  PostCompactionSkillContext
} from '../../../shared/types/context'
import { ContextBudgetService } from './ContextBudgetService'

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
  if (message.role !== 'tool' || message.name !== 'Skill' || message.status !== 'complete') {
    return undefined
  }
  try {
    const wrapper = JSON.parse(message.content)
    return wrapper?.ok === true && typeof wrapper.data === 'string'
      ? wrapper.data
      : undefined
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
      if (call.name !== 'Skill') continue
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

export class SkillContextRestorer {
  constructor(private readonly budget = new ContextBudgetService()) {}

  reconcile(input: {
    context?: PostCompactionSkillContext
    messages: readonly NormalizedModelMessage[]
  }): PostCompactionSkillContext | undefined {
    const context = input.context
    if (!context?.skills.length) return undefined
    const newerNames = new Set(invokedSkills(input.messages)
      .filter((skill) =>
        context.sourceSequence === undefined || skill.invokedSequence > context.sourceSequence
      )
      .map((skill) => skill.name.toLowerCase()))
    return contextFromSkills(
      context.skills.filter((skill) => !newerNames.has(skill.name.toLowerCase())),
      context.createdAt,
      context.sourceSequence
    )
  }

  restore(input: {
    messages: readonly NormalizedModelMessage[]
    retainedTail?: readonly NormalizedModelMessage[]
    existing?: PostCompactionSkillContext
    maxTotalTokens?: number
  }): PostCompactionSkillContext | undefined {
    const maxTotalTokens = Math.max(
      0,
      Math.min(MAX_TOTAL_TOKENS, Math.floor(input.maxTotalTokens ?? MAX_TOTAL_TOKENS))
    )
    if (maxTotalTokens === 0) return undefined
    const latest = new Map<string, InvokedSkillContextEntry>()
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
