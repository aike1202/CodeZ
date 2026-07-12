import type { ToolContext } from '../Tool'
import type { ToolExecutionPipelineContext } from './ToolExecutionPipeline'
import type {
  NormalizedToolCall,
  PreparedToolCall,
  ToolExecutionResult,
  ToolPipelineResult
} from './types'

function failure(code: string, message: string): ToolExecutionResult {
  return {
    status: 'error',
    error: { code, message, recoverable: false },
    modelContent: `Error: ${message}`
  }
}

/** Independent rollback path that preserves the pre-V2 parse/authorize/Promise.all behavior. */
export class LegacyToolExecutionPipeline {
  async executeBatch(
    calls: readonly NormalizedToolCall[],
    context: ToolExecutionPipelineContext
  ): Promise<ToolPipelineResult[]> {
    return Promise.all(calls.map(async (call): Promise<ToolPipelineResult> => {
      const canonicalName = context.catalog.aliases.get(call.name) || call.name
      const handler = context.catalog.handlersByCanonicalName.get(canonicalName)
      if (!handler) return { call, canonicalName, result: failure('TOOL_NOT_FOUND', `Tool '${call.name}' not found.`) }
      let input: Record<string, unknown>
      try {
        const parsed = JSON.parse(call.rawArguments || '{}')
        input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      } catch {
        input = {}
      }
      const prepared: PreparedToolCall = {
        call: { ...call, name: canonicalName },
        handler,
        input,
        effects: { effects: [{ kind: 'unknown', target: canonicalName }], analysisStatus: 'unparsed' },
        resourceKeys: []
      }
      const authorization = await context.authorize(prepared)
      if (!authorization.allowed) {
        return {
          call,
          canonicalName,
          input,
          result: {
            status: 'denied',
            error: authorization.error || { code: 'TOOL_DENIED', message: 'Tool execution denied.', recoverable: false },
            modelContent: `Error: ${authorization.error?.message || 'Tool execution denied.'}`
          }
        }
      }
      const toolContext: ToolContext = context.createToolContext(call, authorization.requestId)
      try {
        return { call, canonicalName, input, result: await handler.execute(input, toolContext) }
      } catch (error: any) {
        return { call, canonicalName, input, result: failure('TOOL_EXECUTION_FAILED', error?.message || String(error)) }
      }
    }))
  }
}
