import type { ToolContext, ToolExecutionOutput } from '../../tools/Tool'
import { interceptAskUser } from '../../tools/builtin/AskUserQuestionTool'
import type { EditTransactionService } from '../../services/EditTransactionService'
import type { AgentRunConfig, AgentRunnerCallbacks } from './types'
import { handleSubAgentRunnerSpawn } from './subAgentRunnerHelper'
import { handleDelegateTasks } from './delegateTasksHelper'
import { handleExecutionControl } from './executionControlHelper'

type RuntimeHandler = (
  input: Record<string, unknown>,
  context: ToolContext
) => Promise<ToolExecutionOutput>

function outputFromMessage(message: { content: string }): ToolExecutionOutput {
  return { content: message.content }
}

export function createAgentRuntimeToolInvoker(input: {
  config: AgentRunConfig
  callbacks: AgentRunnerCallbacks
  parentSignal?: AbortSignal
  parentTransaction?: { id: string; service: EditTransactionService }
}) {
  const callbacks = { ...input.callbacks, onToolEnd: undefined }
  const handlers = new Map<string, RuntimeHandler>([
    ['SubAgentRunner', async (args, context) => outputFromMessage(
      await handleSubAgentRunnerSpawn(
        context.toolCallId || 'unknown',
        JSON.stringify(args),
        input.config,
        callbacks,
        input.parentSignal
      )
    )],
    ['DelegateTasks', async (args, context) => outputFromMessage(
      await handleDelegateTasks(
        context.toolCallId || 'unknown',
        JSON.stringify(args),
        input.config,
        callbacks,
        input.parentSignal,
        input.parentTransaction
      )
    )],
    ['ExecutionControl', async (args, context) => outputFromMessage(
      await handleExecutionControl(
        context.toolCallId || 'unknown',
        JSON.stringify(args),
        input.config,
        callbacks,
        input.parentSignal,
        input.parentTransaction
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

