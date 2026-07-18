import { Tool, ToolContext } from '../Tool'
import { TodoStore, type TodoPatch } from '../../services/TaskStore'
import type {
  TodoApprovalStatus,
  TodoContextBundle,
  TodoRiskLevel,
  TodoStatus
} from '../../../shared/types/task'

const VALID_STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']
const VALID_RISK_LEVELS: TodoRiskLevel[] = ['low', 'medium', 'high']
const VALID_APPROVAL_STATUSES: TodoApprovalStatus[] = [
  'not_required',
  'pending',
  'approved',
  'changes_requested',
  'rejected'
]

type TodoUpdateItem = TodoPatch & { todoId: string }

export class TodoUpdateTool extends Tool {
  get name() {
    return 'TodoUpdate'
  }

  get summary() {
    return 'Atomically update one or more Todo items.'
  }

  get description() {
    return [
      'Apply all Todo patches as one transaction.',
      'Use expectedRevision from the injected todo_state when available.',
      'Use one call to complete the current item and start the next.',
      'The final state must have at most one in_progress item and satisfy dependencies and approval.'
    ].join('\n')
  }

  get parameters_schema() {
    const updateProperties = {
      todoId: { type: 'string', pattern: '^t[1-9][0-9]*$' },
      status: { type: 'string', enum: VALID_STATUSES },
      subject: { type: 'string' },
      description: { type: 'string' },
      addBlockedBy: { type: 'array', items: { type: 'string', pattern: '^t[1-9][0-9]*$' }, uniqueItems: true },
      removeBlockedBy: { type: 'array', items: { type: 'string', pattern: '^t[1-9][0-9]*$' }, uniqueItems: true },
      files: { type: 'array', items: { type: 'string' } },
      activeForm: { type: 'string' },
      groupId: { type: 'string' },
      groupTitle: { type: 'string' },
      groupSubtitle: { type: 'string' },
      riskLevel: { type: 'string', enum: VALID_RISK_LEVELS },
      requiresApproval: { type: 'boolean' },
      approvalStatus: { type: 'string', enum: VALID_APPROVAL_STATUSES },
      acceptanceCriteria: { type: 'array', items: { type: 'string' } },
      verificationCommand: { type: 'string' },
      contextBundle: {
        type: 'object',
        properties: {
          knownFacts: { type: 'array', items: { type: 'string' } },
          decisions: { type: 'array', items: { type: 'string' } },
          constraints: { type: 'array', items: { type: 'string' } },
          excludedDirections: { type: 'array', items: { type: 'string' } },
          sourceReferences: { type: 'array', items: { type: 'string' } }
        },
        additionalProperties: false
      }
    }
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        expectedRevision: { type: 'integer', minimum: 0 },
        updates: {
          type: 'array',
          minItems: 1,
          maxItems: 256,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: updateProperties,
            required: ['todoId'],
            anyOf: Object.keys(updateProperties)
              .filter(key => key !== 'todoId')
              .map(key => ({ required: [key] }))
          }
        }
      },
      required: ['updates']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    const sessionId = context.sessionId
    if (!sessionId) {
      return JSON.stringify({ ok: false, error: 'TodoUpdate requires an active session.' })
    }

    let parsed: { expectedRevision?: number; updates?: TodoUpdateItem[] }
    try {
      parsed = JSON.parse(args || '{}')
    } catch {
      return JSON.stringify({ ok: false, error: 'Invalid JSON arguments for TodoUpdate.' })
    }
    if (!Array.isArray(parsed.updates) || parsed.updates.length === 0) {
      return JSON.stringify({ ok: false, error: 'TodoUpdate requires a non-empty `updates` array.' })
    }
    for (const update of parsed.updates) {
      const error = validateUpdate(update)
      if (error) return JSON.stringify({ ok: false, error })
    }

    const store = TodoStore.getInstance()
    try {
      const result = store.updateBatch(sessionId, parsed.expectedRevision, parsed.updates)
      const updatedIds = new Set(parsed.updates.map(update => update.todoId))
      return JSON.stringify({
        ok: true,
        data: {
          revision: result.revision,
          updated: result.items.filter(item => updatedIds.has(item.id)),
          summary: store.summary(sessionId)
        }
      })
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latest: {
          revision: store.revision(sessionId),
          state: store.promptState(sessionId)
        }
      })
    }
  }
}

function validateUpdate(update: TodoUpdateItem): string | undefined {
  if (!update || typeof update.todoId !== 'string' || !/^t[1-9][0-9]*$/.test(update.todoId)) {
    return 'Each TodoUpdate item requires a valid `todoId`.'
  }
  if (update.status && !VALID_STATUSES.includes(update.status)) {
    return `Invalid status '${update.status}'.`
  }
  if (update.riskLevel && !VALID_RISK_LEVELS.includes(update.riskLevel)) {
    return `Invalid riskLevel '${update.riskLevel}'.`
  }
  if (update.approvalStatus && !VALID_APPROVAL_STATUSES.includes(update.approvalStatus)) {
    return `Invalid approvalStatus '${update.approvalStatus}'.`
  }
  const contextBundle: TodoContextBundle | undefined = update.contextBundle
  if (contextBundle !== undefined && (typeof contextBundle !== 'object' || contextBundle === null)) {
    return 'Invalid contextBundle.'
  }
  return undefined
}

export { TodoUpdateTool as TaskUpdateTool }
