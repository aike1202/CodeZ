import type { ToolApprovalPreference } from '../../../shared/types/permission'
import { fingerprint } from './canonicalJson'
import type {
  JsonSchemaObject,
  ToolApprovalMetadata,
  ToolDescriptor,
  ToolHandler
} from './types'

export const TOOL_APPROVAL_PROPERTY = 'approval'

const APPROVAL_SCHEMA = Object.freeze({
  type: 'string',
  enum: ['auto', 'user'],
  description: 'Choose user only when this operation materially needs explicit user approval; otherwise choose auto.'
})

function schemaProperties(schema: JsonSchemaObject): Record<string, unknown> {
  const properties = schema.properties
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? properties as Record<string, unknown>
    : {}
}

export function decorateApprovalSchema(
  schema: JsonSchemaObject,
  metadata: ToolApprovalMetadata
): JsonSchemaObject {
  if (schema.type !== undefined && schema.type !== 'object') {
    throw new Error('Tool input schema must be an object before CodeZ approval metadata can be applied.')
  }
  const properties = schemaProperties(schema)
  if (Object.prototype.hasOwnProperty.call(properties, TOOL_APPROVAL_PROPERTY)) {
    throw new Error(`Tool input schema uses reserved CodeZ property '${TOOL_APPROVAL_PROPERTY}'.`)
  }
  if (metadata.modelPreference === 'not-applicable') return schema
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === 'string')
    : []
  return {
    ...schema,
    type: 'object',
    properties: {
      ...properties,
      [TOOL_APPROVAL_PROPERTY]: { ...APPROVAL_SCHEMA, enum: [...APPROVAL_SCHEMA.enum] }
    },
    required: [...new Set([...required, TOOL_APPROVAL_PROPERTY])]
  }
}

export function extractToolApproval(
  input: Record<string, unknown>,
  metadata: ToolApprovalMetadata
): { approvalPreference: ToolApprovalPreference | null; businessInput: Record<string, unknown> } {
  const { [TOOL_APPROVAL_PROPERTY]: rawPreference, ...businessInput } = input
  if (metadata.modelPreference === 'not-applicable') {
    return { approvalPreference: null, businessInput }
  }
  if (rawPreference !== 'auto' && rawPreference !== 'user') {
    throw new Error(`Invalid CodeZ approval preference: ${String(rawPreference)}`)
  }
  return { approvalPreference: rawPreference, businessInput }
}

export function decorateToolHandlerApproval<TInput, TOutput>(
  handler: ToolHandler<TInput, TOutput>
): ToolHandler<TInput, TOutput> {
  const approval = handler.descriptor.approval ?? { modelPreference: 'required' as const }
  const descriptor: ToolDescriptor = {
    ...handler.descriptor,
    approval,
    inputSchema: decorateApprovalSchema(handler.descriptor.inputSchema, approval)
  }
  descriptor.version = fingerprint({
    baseVersion: handler.descriptor.version,
    approval: descriptor.approval,
    inputSchema: descriptor.inputSchema
  }).slice(0, 16)
  return {
    descriptor,
    legacyTool: handler.legacyTool,
    execute: (input, context) => handler.execute(input, context)
  }
}
