import type { ToolDefinition } from '../../../shared/types/provider'
import type {
  SubAgentOutputSpec,
  SubAgentOutputField,
  SubAgentStructuredOutput,
  SubAgentQualitySummary
} from '../SubAgentManager'

/**
 * Auto-generate a submit_result tool definition from an output spec.
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
 * Handles: ```json blocks, raw JSON objects.
 */
export function extractJsonBlock(text: string): Record<string, unknown> | null {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]) } catch {}
  }

  const objectMatch = text.match(/\{[\s\S]*\}/)
  if (objectMatch) {
    try { return JSON.parse(objectMatch[0]) } catch {}
  }

  return null
}

/**
 * Validate submit_result data against output spec.
 * Returns structured metadata or undefined if critical fields are missing.
 */
export function validateAgainstSpec(
  data: Record<string, unknown>,
  _spec: SubAgentOutputSpec
): SubAgentStructuredOutput | undefined {
  const report = typeof data.report === 'string' ? data.report : ''
  const conclusion = typeof data.conclusion === 'string' ? data.conclusion : ''
  const confidence = (
    ['high', 'medium', 'low'].includes(data.confidence as string)
      ? data.confidence
      : 'medium'
  ) as 'high' | 'medium' | 'low'

  const filesExamined = Array.isArray(data.filesExamined)
    ? data.filesExamined.filter((f: any) => typeof f === 'string')
    : undefined

  const unresolvedCount = typeof data.unresolvedCount === 'number'
    ? data.unresolvedCount
    : undefined

  // Must have at least a report or conclusion
  if (!report && !conclusion) return undefined

  return { report, conclusion, confidence, filesExamined, unresolvedCount }
}

/**
 * Compute quality signals from structured output vs expectations.
 */
export function computeQualitySummary(
  questions: string[],
  structured: SubAgentStructuredOutput
): SubAgentQualitySummary {
  const expectedCount = questions.length

  let warning: string | null = null
  if (structured.confidence === 'low') {
    warning = 'SubAgent reported low confidence. Findings may need verification.'
  } else if (expectedCount > 0 && structured.confidence === 'medium') {
    warning = 'SubAgent confidence is medium. Spot-check key findings before acting.'
  }

  if (structured.unresolvedCount !== undefined && structured.unresolvedCount > 0) {
    warning = warning
      ? `${warning} Also: ${structured.unresolvedCount} questions unresolved.`
      : `${structured.unresolvedCount} questions unresolved.`
  }

  return {
    coverage: expectedCount > 0 && structured.unresolvedCount !== undefined
      ? (expectedCount - structured.unresolvedCount) / expectedCount
      : (structured.unresolvedCount === undefined ? 1 : 0),
    confidence: structured.confidence,
    unresolvedCount: structured.unresolvedCount ?? 0,
    filesExaminedCount: structured.filesExamined?.length ?? 0,
    warning,
  }
}
