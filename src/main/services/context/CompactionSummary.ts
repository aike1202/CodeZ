import type {
  CompactionSummary,
  CompactionSummaryV1,
  NormalizedModelMessage,
  VersionedResumeState
} from '../../../shared/types/context'

export interface BuildCompactionPromptInput {
  coveredThroughSequence: number
  messages: NormalizedModelMessage[]
  previousSummary?: CompactionSummary
  resumeState?: VersionedResumeState
  instructions?: string
  validationFeedback?: string
}

function invalid(detail: string): never {
  throw Object.assign(new Error(`COMPACTION_SCHEMA_INVALID: ${detail}`), {
    code: 'COMPACTION_SCHEMA_INVALID'
  })
}

function object(value: unknown, path: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${path} must be an object`)
  return value as Record<string, any>
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') invalid(`${path} must be a string`)
  return value
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) invalid(`${path} must be a string array`)
  return value
}

function objectArray(value: unknown, path: string): Record<string, any>[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array`)
  return value.map((item, index) => object(item, `${path}[${index}]`))
}

export function parseAndValidateSummary(
  raw: string,
  expectedCoveredThroughSequence: number,
  maxChars = 32_000
): CompactionSummaryV1 {
  if (raw.length > maxChars) invalid('summary exceeds the configured size limit')
  if (raw.trim().startsWith('```')) invalid('code fences are not accepted')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    invalid('invalid JSON')
  }
  const root = object(parsed, 'summary')
  if (root.version !== 1) invalid('version must be 1')
  if (root.coveredThroughSequence !== expectedCoveredThroughSequence) {
    invalid(`coveredThroughSequence must equal ${expectedCoveredThroughSequence}`)
  }

  const goal = object(root.goal, 'goal')
  string(goal.currentObjective, 'goal.currentObjective')
  stringArray(goal.requirements, 'goal.requirements')
  stringArray(goal.successCriteria, 'goal.successCriteria')
  if (goal.originalRequest !== undefined) string(goal.originalRequest, 'goal.originalRequest')

  const status = object(root.status, 'status')
  string(status.phase, 'status.phase')
  stringArray(status.completed, 'status.completed')
  stringArray(status.inProgress, 'status.inProgress')
  stringArray(status.nextActions, 'status.nextActions')

  objectArray(root.decisions, 'decisions').forEach((item, index) => {
    string(item.decision, `decisions[${index}].decision`)
    if (item.rationale !== undefined) string(item.rationale, `decisions[${index}].rationale`)
  })
  objectArray(root.facts, 'facts').forEach((item, index) => string(item.fact, `facts[${index}].fact`))
  objectArray(root.files, 'files').forEach((item, index) => {
    string(item.path, `files[${index}].path`)
    string(item.relevance, `files[${index}].relevance`)
    if (!['read', 'modified', 'created', 'deleted', 'unknown'].includes(item.state)) invalid(`files[${index}].state is invalid`)
  })
  objectArray(root.validation, 'validation').forEach((item, index) => {
    string(item.commandOrCheck, `validation[${index}].commandOrCheck`)
    string(item.result, `validation[${index}].result`)
    if (!['passed', 'failed', 'pending'].includes(item.status)) invalid(`validation[${index}].status is invalid`)
  })
  objectArray(root.errors, 'errors').forEach((item, index) => string(item.symptom, `errors[${index}].symptom`))
  stringArray(root.openQuestions, 'openQuestions')
  stringArray(root.userInstructions, 'userInstructions')
  return root as CompactionSummaryV1
}

export function normalizeCompactionSummary(
  raw: string,
  coveredThroughSequence: number,
  options: { maxChars?: number; truncatedPrefixThroughSequence?: number } = {}
): CompactionSummary {
  const maxChars = options.maxChars ?? 96_000
  const trimmed = raw.trim()
  if (!trimmed) invalid('summary is empty')
  if (trimmed.length > maxChars) invalid('summary exceeds the configured size limit')

  if (trimmed.startsWith('{')) {
    try {
      return parseAndValidateSummary(trimmed, coveredThroughSequence, maxChars)
    } catch (error) {
      if ((error as any)?.code !== 'COMPACTION_SCHEMA_INVALID') throw error
    }
  }

  let content = trimmed.replace(/<analysis>[\s\S]*?<\/analysis>/i, '').trim()
  const tagged = content.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (tagged) content = tagged[1].trim()
  if (content.startsWith('```') && content.endsWith('```')) {
    content = content.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim()
  }
  if (!content) invalid('summary is empty after removing analysis')

  return {
    version: 2,
    format: 'text',
    content,
    coveredThroughSequence,
    ...(options.truncatedPrefixThroughSequence !== undefined
      ? { truncatedPrefixThroughSequence: options.truncatedPrefixThroughSequence }
      : {})
  }
}

function list(label: string, values: string[]): string {
  return `${label}: ${values.length ? values.join('; ') : 'none'}`
}

export function renderCompactionSummary(summary: CompactionSummary): string {
  if (summary.version === 2) {
    return [
      '<compaction_summary version="2">',
      summary.truncatedPrefixThroughSequence !== undefined
        ? `[Earlier history through sequence ${summary.truncatedPrefixThroughSequence} was omitted after the Provider rejected the compaction input as too large.]`
        : '',
      summary.content,
      `Covered through sequence: ${summary.coveredThroughSequence}`,
      '</compaction_summary>'
    ].filter(Boolean).join('\n')
  }
  return [
    '<compaction_summary version="1">',
    `Current objective: ${summary.goal.currentObjective}`,
    list('Requirements', summary.goal.requirements),
    list('Success criteria', summary.goal.successCriteria),
    `Phase: ${summary.status.phase}`,
    list('Completed', summary.status.completed),
    list('In progress', summary.status.inProgress),
    list('Next actions', summary.status.nextActions),
    list('Decisions', summary.decisions.map((item) => item.rationale ? `${item.decision} (${item.rationale})` : item.decision)),
    list('Facts', summary.facts.map((item) => item.evidence ? `${item.fact} (${item.evidence})` : item.fact)),
    list('Files', summary.files.map((item) => `${item.path} [${item.state}]: ${item.relevance}`)),
    list('Validation', summary.validation.map((item) => `${item.commandOrCheck} [${item.status}]: ${item.result}`)),
    list('Errors', summary.errors.map((item) => item.resolution ? `${item.symptom}: ${item.resolution}` : item.symptom)),
    list('Open questions', summary.openQuestions),
    list('User instructions', summary.userInstructions),
    `Covered through sequence: ${summary.coveredThroughSequence}`,
    '</compaction_summary>'
  ].join('\n')
}

export function buildCompactionPrompt(input: BuildCompactionPromptInput): string {
  const transcript = input.messages.map((message) => JSON.stringify({
    sequence: message.sourceSequence,
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    name: message.name
  })).join('\n')
  return [
    'CRITICAL: Respond with text only. Do not call tools.',
    'Create a detailed continuation summary of the durable coding-agent history.',
    'Write a short <analysis> drafting block followed by one <summary> block.',
    'The <summary> must preserve the user request, requirements, completed and pending work, decisions, files, errors, validation results, and the exact next action.',
    'Do not claim work completed without evidence. Omit long source text and resolved logs.',
    'The host records the durable sequence boundary; do not output JSON or sequence metadata.',
    input.validationFeedback ? `Previous output could not be used: ${input.validationFeedback}` : '',
    input.instructions ? `One-shot retention instructions: ${input.instructions}` : '',
    input.previousSummary ? `Previous summary:\n${renderCompactionSummary(input.previousSummary)}` : '',
    input.resumeState ? `Resume state:\n${JSON.stringify(input.resumeState)}` : '',
    `New history:\n${transcript}`,
    'REMINDER: Return text only as <analysis>...</analysis> followed by <summary>...</summary>.'
  ].filter(Boolean).join('\n\n')
}
