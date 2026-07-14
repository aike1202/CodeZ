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
    case 'reviewFinding[]':
      return {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'Stable finding ID, for example F-001.' },
            criterionId: { type: 'string', description: 'Frozen acceptance criterion ID, for example AC-1.' },
            severity: { type: 'string', enum: ['P0', 'P1'] },
            location: { type: 'string', description: 'Specific file and line, symbol, or contract location.' },
            expected: { type: 'string' },
            actual: { type: 'string' },
            reproduction: { type: 'string', description: 'Concrete counterexample or reproducible failure path.' },
            evidence: { type: 'string', description: 'Observed repository evidence supporting the blocker.' },
            confidence: { type: 'string', enum: ['high'] }
          },
          required: [
            'id',
            'criterionId',
            'severity',
            'location',
            'expected',
            'actual',
            'reproduction',
            'evidence',
            'confidence'
          ]
        },
        description: field.description
      }
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
  spec: SubAgentOutputSpec
): SubAgentStructuredOutput | undefined {
  const normalized: Record<string, unknown> = {}

  for (const field of spec.fields) {
    const value = data[field.name]
    if (value === undefined || value === null) {
      if (field.required) return undefined
      continue
    }

    const normalizedValue = normalizeFieldValue(value, field)
    if (normalizedValue === undefined) {
      return undefined
    }
    normalized[field.name] = normalizedValue
  }

  const summary = typeof normalized.summary === 'string' ? normalized.summary : ''
  normalized.report = typeof normalized.report === 'string' ? normalized.report : summary
  normalized.conclusion =
    typeof normalized.conclusion === 'string' ? normalized.conclusion : summary
  normalized.confidence = (
    ['high', 'medium', 'low'].includes(normalized.confidence as string)
      ? normalized.confidence
      : 'medium'
  ) as 'high' | 'medium' | 'low'

  return normalized as unknown as SubAgentStructuredOutput
}

function normalizeFieldValue(value: unknown, field: SubAgentOutputField): unknown | undefined {
  switch (field.type) {
    case 'string':
      return typeof value === 'string' ? value : undefined
    case 'string[]':
      return Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? value
        : undefined
    case 'number':
      return typeof value === 'number' ? value : undefined
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined
    case 'reviewFinding[]':
      if (!Array.isArray(value)) return undefined
      return value.every((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false
        const finding = item as Record<string, unknown>
        return (
          typeof finding.id === 'string' &&
          typeof finding.criterionId === 'string' &&
          (finding.severity === 'P0' || finding.severity === 'P1') &&
          typeof finding.location === 'string' &&
          typeof finding.expected === 'string' &&
          typeof finding.actual === 'string' &&
          typeof finding.reproduction === 'string' &&
          typeof finding.evidence === 'string' &&
          finding.confidence === 'high'
        )
      }) ? value : undefined
    default:
      return undefined
  }
}

export function formatSubmitResultValidationMessage(spec: SubAgentOutputSpec): string {
  const required = spec.fields
    .filter(field => field.required)
    .map(field => `"${field.name}" (${field.type})`)
  const optional = spec.fields
    .filter(field => !field.required)
    .map(field => `"${field.name}" (${field.type})`)

  return [
    'submit_result data did not match the expected schema.',
    required.length > 0 ? `Required fields: ${required.join(', ')}.` : '',
    optional.length > 0 ? `Optional fields: ${optional.join(', ')}.` : '',
    'Then call submit_result again.',
  ].filter(Boolean).join(' ')
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
