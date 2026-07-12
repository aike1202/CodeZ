import { Tool, type ToolContext } from '../Tool'
import { getLargeToolResultStore } from '../runtime/LargeToolResultStore'
import type { ToolExecutionResult } from '../runtime/types'

export class ToolResultReadTool extends Tool {
  get name() { return 'ToolResultRead' }
  get summary() { return 'Read a persisted tool result by opaque handle' }
  get description() {
    return 'Read a bounded chunk from a tool-result:// handle returned by a previous tool call. This tool does not accept filesystem paths.'
  }
  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        handle: { type: 'string', pattern: '^tool-result://[A-Za-z0-9_-]+$' },
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 50000, default: 20000 }
      },
      required: ['handle'],
      additionalProperties: false
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    if (!context.sessionId) return JSON.stringify({ ok: false, error: 'ToolResultRead requires an active session.' })
    const input = JSON.parse(args) as { handle: string; offset?: number; limit?: number }
    try {
      const result = await getLargeToolResultStore().read({
        workspaceRoot: context.workspaceRoot,
        sessionId: context.sessionId,
        ...input
      })
      return JSON.stringify({ ok: true, data: result })
    } catch (error: any) {
      return JSON.stringify({ ok: false, error: error?.message || String(error) })
    }
  }

  async executeTyped(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    if (!context.sessionId) {
      return {
        status: 'error',
        error: { code: 'TOOL_RESULT_SESSION_REQUIRED', message: 'ToolResultRead requires an active session.', recoverable: false }
      }
    }
    try {
      const data = await getLargeToolResultStore().read({
        workspaceRoot: context.workspaceRoot,
        sessionId: context.sessionId,
        ...(input as { handle: string; offset?: number; limit?: number })
      })
      return { status: 'success', data, modelContent: JSON.stringify(data) }
    } catch (error: any) {
      return {
        status: 'error',
        error: { code: 'TOOL_RESULT_READ_FAILED', message: error?.message || String(error), recoverable: true }
      }
    }
  }
}
