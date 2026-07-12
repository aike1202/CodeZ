import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import type { ToolCatalogSnapshot } from './types'

export interface ToolInputValidationSuccess {
  ok: true
  input: Record<string, unknown>
}

export interface ToolInputValidationFailure {
  ok: false
  error: {
    code: 'TOOL_ARGUMENTS_TOO_LARGE' | 'TOOL_ARGUMENTS_INVALID_JSON' | 'TOOL_INPUT_INVALID'
    message: string
    issues?: string[]
  }
}

export type ToolInputValidationResult = ToolInputValidationSuccess | ToolInputValidationFailure

function issueFromAjv(error: ErrorObject): string {
  const path = error.instancePath
    ? error.instancePath.replace(/\/(\d+)/g, '[$1]').replace(/\//g, '.')
    : ''
  if (error.keyword === 'required') {
    return `The required parameter \`${(error.params as any).missingProperty}\` is missing`
  }
  if (error.keyword === 'additionalProperties') {
    return `The unexpected parameter \`${(error.params as any).additionalProperty}\` was provided`
  }
  return `${path || 'input'} ${error.message || 'is invalid'}`
}

export class ToolInputValidator {
  private readonly ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true })
  private readonly validators = new Map<string, ValidateFunction>()

  constructor(private readonly maxArgumentsBytes = 1024 * 1024) {}

  compile(snapshot: ToolCatalogSnapshot): void {
    for (const descriptor of snapshot.descriptors) {
      const key = `${snapshot.fingerprint}:${descriptor.name}:${descriptor.version}`
      if (!this.validators.has(key)) {
        this.validators.set(key, this.ajv.compile(descriptor.inputSchema))
      }
    }
  }

  validate(
    snapshot: ToolCatalogSnapshot,
    toolName: string,
    rawArguments: string
  ): ToolInputValidationResult {
    if (Buffer.byteLength(rawArguments, 'utf8') > this.maxArgumentsBytes) {
      return {
        ok: false,
        error: {
          code: 'TOOL_ARGUMENTS_TOO_LARGE',
          message: `${toolName} arguments exceed the ${this.maxArgumentsBytes} byte limit.`
        }
      }
    }
    let parsed: unknown
    try {
      parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {}
    } catch (error: any) {
      return {
        ok: false,
        error: {
          code: 'TOOL_ARGUMENTS_INVALID_JSON',
          message: `${toolName} arguments are not valid JSON: ${error?.message || String(error)}`
        }
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        error: {
          code: 'TOOL_INPUT_INVALID',
          message: `${toolName} input must be a JSON object.`,
          issues: ['The tool input must be an object']
        }
      }
    }
    const handler = snapshot.handlersByCanonicalName.get(toolName)
    if (!handler) {
      return {
        ok: false,
        error: { code: 'TOOL_INPUT_INVALID', message: `Tool '${toolName}' is not in the catalog snapshot.` }
      }
    }
    const key = `${snapshot.fingerprint}:${handler.descriptor.name}:${handler.descriptor.version}`
    let validator = this.validators.get(key)
    if (!validator) {
      validator = this.ajv.compile(handler.descriptor.inputSchema)
      this.validators.set(key, validator)
    }
    if (!validator(parsed)) {
      const issues = (validator.errors || []).map(issueFromAjv)
      return {
        ok: false,
        error: {
          code: 'TOOL_INPUT_INVALID',
          message: `${toolName} input is invalid.`,
          issues
        }
      }
    }
    return { ok: true, input: parsed as Record<string, unknown> }
  }
}

