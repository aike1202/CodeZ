import type { ToolDefinition } from '../../../shared/types/provider'
import type {
  SubAgentOutputSpec,
  SubAgentOutputField,
  SubAgentStructuredOutput,
  SubAgentAnswer,
  SubAgentUnresolved,
  SubAgentQualitySummary
} from '../SubAgentManager'

/**
 * Auto-generate a submit_result tool definition from an output spec.
 * The SubAgent calls this as its final action to submit structured findings.
 */
export function generateSubmitResultTool(spec: SubAgentOutputSpec): ToolDefinition {
  const properties: Record<string, any> = {}
  const required: string[] = []

  for (const field of spec.fields) {
    properties[field.name] = buildFieldSchema(field)
    if (field.required) {
      required.push(field.name)
    }
  }

  return {
    type: 'function',
    function: {
      name: 'submit_result',
      description: spec.description,
      parameters: {
        type: 'object',
        properties,
        required
      }
    }
  }
}

function buildFieldSchema(field: SubAgentOutputField): Record<string, any> {
  switch (field.type) {
    case 'string':
      return { type: 'string', description: field.description }
    case 'string[]':
      return {
        type: 'array',
        items: { type: 'string' },
        description: field.description
      }
    case 'number':
      return { type: 'number', description: field.description }
    case 'boolean':
      return { type: 'boolean', description: field.description }
    default:
      return { type: 'string', description: field.description }
  }
}

/**
 * Best-effort JSON extraction from plain text.
 * Handles: ```json blocks, raw JSON objects, and malformed wrapping.
 */
export function extractJsonBlock(text: string): Record<string, unknown> | null {
  // Try ```json ... ``` block
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1])
    } catch {
      // fall through
    }
  }

  // Try raw JSON object
  const objectMatch = text.match(/\{[\s\S]*\}/)
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0])
    } catch {
      // fall through
    }
  }

  return null
}

/**
 * Validate extracted data against the output spec. Returns structured output
 * or undefined if validation fails critically.
 */
export function validateAgainstSpec(
  data: Record<string, unknown>,
  _spec: SubAgentOutputSpec
): SubAgentStructuredOutput | undefined {
  const result: SubAgentStructuredOutput = {
    conclusion: '',
    answers: [],
    unresolved: [],
  }

  // Validate the native shape we expect
  if (typeof data.conclusion === 'string') {
    result.conclusion = data.conclusion
  }

  if (Array.isArray(data.answers)) {
    result.answers = data.answers
      .filter((a: any) => typeof a?.question === 'string' && typeof a?.answer === 'string')
      .map((a: any) => ({
        question: a.question,
        answer: a.answer,
        confidence: (['confirmed', 'likely', 'speculative'].includes(a.confidence)
          ? a.confidence
          : 'likely') as 'confirmed' | 'likely' | 'speculative',
        evidence: Array.isArray(a.evidence)
          ? a.evidence.filter(
              (e: any) => typeof e?.file === 'string' && typeof e?.line === 'number'
            )
          : [],
      }))
  }

  if (Array.isArray(data.unresolved)) {
    result.unresolved = data.unresolved
      .filter((u: any) => typeof u?.question === 'string')
      .map((u: any) => ({
        question: u.question,
        reason: typeof u.reason === 'string' ? u.reason : 'No reason provided',
      }))
  }

  if (Array.isArray(data.additionalDiscoveries)) {
    result.additionalDiscoveries = data.additionalDiscoveries
      .filter((a: any) => typeof a?.question === 'string' && typeof a?.answer === 'string')
      .map((a: any) => ({
        question: a.question,
        answer: a.answer,
        confidence: (['confirmed', 'likely', 'speculative'].includes(a.confidence)
          ? a.confidence
          : 'likely') as 'confirmed' | 'likely' | 'speculative',
        evidence: Array.isArray(a.evidence)
          ? a.evidence.filter(
              (e: any) => typeof e?.file === 'string' && typeof e?.line === 'number'
            )
          : [],
      }))
  }

  // Only return if we got at least a conclusion or some answers
  if (!result.conclusion && result.answers.length === 0) {
    return undefined
  }

  return result
}

/**
 * Compute quality signals from structured output vs expectations.
 * Gives the main Agent a trust-level signal without requiring full re-verification.
 */
export function computeQualitySummary(
  questions: string[],
  structured: SubAgentStructuredOutput
): SubAgentQualitySummary {
  const expectedCount = questions.length
  if (expectedCount === 0) {
    return {
      coverage: 1,
      confirmedRatio: 0,
      unresolvedCount: structured.unresolved.length,
      warning: null,
    }
  }

  const answeredCount = structured.answers.length
  const confirmedCount = structured.answers.filter(
    (a) => a.confidence === 'confirmed'
  ).length

  const coverage = answeredCount / expectedCount
  const confirmedRatio = answeredCount > 0 ? confirmedCount / answeredCount : 0

  let warning: string | null = null
  if (coverage < 0.5) {
    warning = `Only ${Math.round(coverage * 100)}% of questions were answered (${answeredCount}/${expectedCount}). Consider re-delegating or investigating directly.`
  } else if (confirmedRatio < 0.3 && answeredCount > 0) {
    warning = `Only ${Math.round(confirmedRatio * 100)}% of answers are confirmed. Most findings need verification.`
  }

  return {
    coverage,
    confirmedRatio,
    unresolvedCount: structured.unresolved.length,
    warning,
  }
}
