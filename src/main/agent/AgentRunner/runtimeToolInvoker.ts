import type { ToolContext, ToolExecutionOutput } from '../../tools/Tool'
import { interceptAskUser } from '../../tools/builtin/AskUserQuestionTool'
import type { EditTransactionService } from '../../services/EditTransactionService'
import type { AgentRunConfig, AgentRunnerCallbacks } from './types'
import { handleSubAgentRunnerSpawn } from './subAgentRunnerHelper'
import { SubAgentManager } from '../SubAgentManager'
import { getAgentCollaborationRuntime } from '../../services/agents'

type RuntimeHandler = (
  input: Record<string, unknown>,
  context: ToolContext
) => Promise<ToolExecutionOutput>

function outputFromMessage(message: { content: string }): ToolExecutionOutput {
  return { content: message.content }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function collaborationEnvironment(
  input: Parameters<typeof createAgentRuntimeToolInvoker>[0],
  context: ToolContext
) {
  return {
    config: input.config,
    callbacks: { ...input.callbacks, onToolEnd: undefined },
    parentSignal: input.parentSignal,
    parentContextScopeId: context.contextScopeId,
    parentToolCallId: context.toolCallId,
    parentTransaction: input.parentTransaction
  }
}

export function createAgentRuntimeToolInvoker(input: {
  config: AgentRunConfig
  callbacks: AgentRunnerCallbacks
  parentSignal?: AbortSignal
  parentTransaction?: { id: string; service: EditTransactionService }
}) {
  const callbacks = { ...input.callbacks, onToolEnd: undefined }
  const handlers = new Map<string, RuntimeHandler>([
    ['spawn_agent', async (args, context) => {
      const type = String(args.subagent_type || '')
      const definition = SubAgentManager.getDefinition(type)
      const allowedWriteFiles = stringArray(args.allowed_write_files)
      const record = await getAgentCollaborationRuntime().spawn({
        type,
        taskName: String(args.task_name || ''),
        description: String(args.description || ''),
        message: String(args.message || ''),
        context: typeof args.context === 'string' ? args.context : undefined,
        expectations: args.expectations && typeof args.expectations === 'object'
          ? {
              questions: stringArray((args.expectations as Record<string, unknown>).questions) || [],
              outOfScope: stringArray((args.expectations as Record<string, unknown>).outOfScope)
            }
          : undefined,
        scope: args.scope && typeof args.scope === 'object'
          ? {
              directories: stringArray((args.scope as Record<string, unknown>).directories),
              excludeGlobs: stringArray((args.scope as Record<string, unknown>).excludeGlobs)
            }
          : undefined,
        depth: ['quick', 'normal', 'exhaustive'].includes(String(args.depth))
          ? args.depth as 'quick' | 'normal' | 'exhaustive'
          : undefined,
        permissionScope: definition?.allowShell
          ? {
              allowBash: true,
              allowedWriteFiles: allowedWriteFiles || [],
              shellPolicy: definition.shellPolicy
            }
          : undefined
      }, collaborationEnvironment(input, context))
      return {
        content: JSON.stringify({
          ok: true,
          data: { agent_id: record.id, path: record.path, status: record.status }
        })
      }
    }],
    ['followup_task', async (args, context) => {
      const record = await getAgentCollaborationRuntime().followup(
        String(args.target || ''),
        String(args.message || ''),
        collaborationEnvironment(input, context)
      )
      return {
        content: JSON.stringify({
          ok: true,
          data: { agent_id: record.id, path: record.path, status: record.status }
        })
      }
    }],
    ['SubAgentRunner', async (args, context) => outputFromMessage(
      await handleSubAgentRunnerSpawn(
        context.toolCallId || 'unknown',
        JSON.stringify(args),
        input.config,
        callbacks,
        input.parentSignal
      )
    )],
    ['AskUserQuestion', async (args, context) => {
      const intercepted = await interceptAskUser(
        'AskUserQuestion',
        args,
        context.permissionRequestId || context.toolCallId || 'unknown',
        input.callbacks.onAskUserRequest || null
      )
      if (!intercepted.handled) return { content: 'Error: AskUserQuestion handler was not invoked.' }
      return { content: intercepted.result || '' }
    }]
  ])

  return async (
    name: string,
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionOutput | null> => {
    const handler = handlers.get(name)
    return handler ? handler(args, context) : null
  }
}
