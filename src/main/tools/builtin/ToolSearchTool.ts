import { Tool, type ToolContext } from '../Tool'
import type { DeferredToolSummary, ToolExecutionResult } from '../runtime/types'

function searchableName(name: string): string[] {
  return name
    .replace(/^mcp__/, '')
    .replace(/__/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

function findExact(tools: readonly DeferredToolSummary[], name: string): DeferredToolSummary | undefined {
  const normalized = name.trim().toLowerCase()
  return tools.find((tool) => tool.name.toLowerCase() === normalized)
}

function search(
  tools: readonly DeferredToolSummary[],
  query: string,
  maxResults: number
): DeferredToolSummary[] {
  const normalized = query.trim().toLowerCase()
  const exact = findExact(tools, normalized)
  if (exact) return [exact]
  if (normalized.startsWith('mcp__')) {
    const prefix = tools
      .filter((tool) => tool.name.toLowerCase().startsWith(normalized))
      .slice(0, maxResults)
    if (prefix.length > 0) return prefix
  }

  const required: string[] = []
  const optional: string[] = []
  for (const term of normalized.split(/\s+/).filter(Boolean)) {
    if (term.startsWith('+') && term.length > 1) required.push(term.slice(1))
    else optional.push(term)
  }
  const terms = required.length > 0 ? [...required, ...optional] : optional
  return tools
    .map((tool) => {
      const nameParts = searchableName(tool.name)
      const nameText = nameParts.join(' ')
      const summary = `${tool.summary} ${tool.searchHint || ''}`.toLowerCase()
      if (required.some((term) => !nameText.includes(term) && !summary.includes(term))) {
        return { tool, score: 0 }
      }
      let score = 0
      for (const term of terms) {
        if (nameParts.includes(term)) score += tool.name.startsWith('mcp__') ? 12 : 10
        else if (nameParts.some((part) => part.includes(term))) score += 5
        if (summary.includes(term)) score += 3
      }
      return { tool, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, maxResults)
    .map((item) => item.tool)
}

export class ToolSearchTool extends Tool {
  get name() { return 'ToolSearch' }
  get summary() { return 'Find and activate deferred tools' }
  get description() {
    return 'Find tools whose schemas are deferred. Use select:<tool_name> for direct selection or capability keywords. Matching tools become available on the next model turn.'
  }
  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          description: 'Tool name or capability query. Use select:<tool_name> for direct selection.'
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          default: 5
        }
      },
      required: ['query'],
      additionalProperties: false
    }
  }

  private run(input: { query: string; max_results?: number }, context: ToolContext) {
    const deferred = context.toolExposure?.deferredTools || []
    const direct = input.query.match(/^select:(.+)$/i)
    let matches: DeferredToolSummary[]
    if (direct) {
      const selected = direct[1].split(',').map((name) => name.trim()).filter(Boolean)
      matches = selected
        .map((name) => findExact(deferred, name))
        .filter((tool): tool is DeferredToolSummary => Boolean(tool))
    } else {
      matches = search(deferred, input.query, input.max_results || 5)
    }
    const activated = [...new Set(matches.map((tool) => tool.name))]
    context.toolExposure?.activate(activated)
    return { activated, availableNextTurn: true, totalDeferredTools: deferred.length, summaries: matches }
  }

  async executeTyped(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const data = this.run(input as { query: string; max_results?: number }, context)
    return { status: 'success', data, modelContent: JSON.stringify(data) }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    return JSON.stringify({ ok: true, data: this.run(JSON.parse(args), context) })
  }
}
