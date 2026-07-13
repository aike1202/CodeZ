import { getLargeToolResultStore, type LargeToolResultStore } from './LargeToolResultStore'
import type { ToolPipelineResult } from './types'

function truncateMiddle(content: string, limit: number): string {
  if (content.length <= limit) return content
  const head = Math.ceil(limit * 0.7)
  const tail = Math.floor(limit * 0.3)
  return `${content.slice(0, head)}\n...[truncated ${content.length - limit} chars]...\n${content.slice(-tail)}`
}

export class ToolResultProcessor {
  constructor(
    private readonly store: LargeToolResultStore = getLargeToolResultStore(),
    private readonly limits = {
      softChars: 50_000,
      hardBytes: 400_000,
      batchChars: 200_000,
      previewChars: 2_000,
      errorChars: 10_000
    },
    private readonly persistenceEnabled = true
  ) {}

  async processBatch(
    results: readonly ToolPipelineResult[],
    context: { workspaceRoot: string; sessionId?: string }
  ): Promise<ToolPipelineResult[]> {
    const processed = results.map((item): ToolPipelineResult => {
      if (item.result.status === 'success' && typeof item.result.modelContent !== 'string') {
        const modelContent = JSON.stringify(item.result.data ?? '') ?? ''
        return { ...item, result: { ...item.result, modelContent } }
      }
      if (item.result.status === 'success') return item
      const modelContent = truncateMiddle(item.result.modelContent || `Error: ${item.result.error.message}`, this.limits.errorChars)
      return { ...item, result: { ...item.result, modelContent } }
    })
    if (!context.sessionId) return processed

    const candidates = processed
      .filter((item) => item.result.status === 'success')
      .map((item) => ({
        item,
        chars: item.result.status === 'success' ? item.result.modelContent.length : 0,
        bytes: item.result.status === 'success' ? Buffer.byteLength(item.result.modelContent, 'utf8') : 0
      }))
    let batchChars = candidates.reduce((sum, candidate) => sum + candidate.chars, 0)
    const mustPersist = new Set(candidates
      .filter((candidate) => candidate.chars > this.limits.softChars || candidate.bytes > this.limits.hardBytes)
      .map((candidate) => candidate.item.call.callId))
    for (const candidate of [...candidates].sort((a, b) => b.chars - a.chars)) {
      if (batchChars <= this.limits.batchChars) break
      mustPersist.add(candidate.item.call.callId)
      batchChars -= candidate.chars
    }

    if (!this.persistenceEnabled) {
      return processed.map((item) => {
        if (item.result.status !== 'success' || !mustPersist.has(item.call.callId)) return item
        return {
          ...item,
          result: {
            status: 'error' as const,
            error: {
              code: 'TOOL_RESULT_TOO_LARGE',
              message: 'Tool output exceeded the hard model-result budget while result persistence was disabled.',
              recoverable: true,
              suggestion: 'Retry with a smaller limit or enable CODEZ_TOOL_RESULT_STORE.'
            },
            modelContent: 'Error: Tool output exceeded the hard model-result budget.'
          }
        }
      })
    }

    return Promise.all(processed.map(async (item) => {
      if (item.result.status !== 'success' || !mustPersist.has(item.call.callId)) return item
      const fullContent = item.result.modelContent
      try {
        const persisted = await this.store.persist({
          workspaceRoot: context.workspaceRoot,
          sessionId: context.sessionId!,
          callId: item.call.callId,
          toolName: item.canonicalName,
          content: fullContent
        })
        const preview = truncateMiddle(fullContent, this.limits.previewChars)
        return {
          ...item,
          result: {
            ...item.result,
            modelContent: [
              `<persisted-tool-result id="${persisted.handle}" original_chars="${persisted.originalChars}" sha256="${persisted.sha256}">`,
              'Output was too large. A preview follows.',
              preview,
              '</persisted-tool-result>'
            ].join('\n')
          }
        }
      } catch (error: any) {
        return {
          ...item,
          result: {
            status: 'error' as const,
            error: {
              code: 'TOOL_RESULT_PERSIST_FAILED',
              message: error?.message || String(error),
              recoverable: false
            },
            modelContent: 'Error: The tool result exceeded the context budget and could not be persisted.'
          }
        }
      }
    }))
  }
}
