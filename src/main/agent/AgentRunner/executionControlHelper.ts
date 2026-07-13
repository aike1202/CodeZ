import path from 'path'
import { getExecutionController } from '../../services/execution/ExecutionController'
import { SubAgentManager } from '../SubAgentManager'
import { WorktreeService } from '../../services/WorktreeService'
import type { AgentRunConfig, AgentRunnerCallbacks } from './types'
import type { StepResult } from '../../../shared/types/parallel'
import type { EditTransactionService } from '../../services/EditTransactionService'
import {
  failureReasonFromResult,
  mergeWorktreeTracked,
  normalizeWorkerResult
} from './parallelOrchestrator'

type ControlAction = 'stop_executor' | 'stop_all' | 'takeover' | 'resume' | 'restart' | 'accept_completed'

interface ControlArgs {
  execution_id?: string
  executor_id?: string
  action?: ControlAction
  reason?: string
}

function toolResult(toolCallId: string, ok: boolean, dataOrError: unknown) {
  return {
    role: 'tool' as const,
    tool_call_id: toolCallId,
    name: 'ExecutionControl',
    content: JSON.stringify(ok ? { ok: true, data: dataOrError } : { ok: false, error: dataOrError })
  }
}

/** AgentRunner interception for control actions that need current model credentials/callbacks. */
export async function handleExecutionControl(
  toolCallId: string,
  rawArgs: string,
  config: AgentRunConfig,
  callbacks: AgentRunnerCallbacks,
  parentSignal?: AbortSignal,
  parentTransaction?: { id: string; service: EditTransactionService }
) {
  let parsed: ControlArgs
  try {
    parsed = JSON.parse(rawArgs || '{}')
  } catch {
    return toolResult(toolCallId, false, 'Invalid JSON arguments for ExecutionControl.')
  }
  const sessionId = config.sessionId
  if (!sessionId || !parsed.execution_id || !parsed.action) {
    return toolResult(toolCallId, false, 'An active session, execution_id, and action are required.')
  }

  const controller = getExecutionController()
  controller.restoreSession(config.workspaceRoot, sessionId)
  const execution = controller.getExecution(parsed.execution_id)
  if (!execution || execution.sessionId !== sessionId) {
    return toolResult(toolCallId, false, `Execution '${parsed.execution_id}' was not found in this session.`)
  }

  if (parsed.action === 'stop_all') {
    return toolResult(toolCallId, true, controller.stopExecution(execution.executionId, parsed.reason))
  }
  if (parsed.action === 'accept_completed') {
    try {
      const snapshot = await controller.acceptCompleted(execution.executionId, parsed.executor_id)
      return toolResult(toolCallId, true, snapshot)
    } catch (error) {
      return toolResult(toolCallId, false, error instanceof Error ? error.message : String(error))
    }
  }
  if (!parsed.executor_id) {
    return toolResult(toolCallId, false, `executor_id is required for ${parsed.action}.`)
  }
  if (parsed.action === 'stop_executor') {
    return toolResult(toolCallId, true, controller.stopExecutor(execution.executionId, parsed.executor_id, parsed.reason))
  }
  if (parsed.action === 'takeover') {
    return toolResult(toolCallId, true, controller.takeover(execution.executionId, parsed.executor_id))
  }

  const executor = execution.executors.find((item) => item.executorId === parsed.executor_id)
  if (!executor) return toolResult(toolCallId, false, `Executor '${parsed.executor_id}' was not found.`)
  if (!['failed', 'interrupted', 'stopped', 'lost', 'paused'].includes(executor.status)) {
    return toolResult(toolCallId, false, `Executor '${executor.executorId}' cannot ${parsed.action} while ${executor.status}.`)
  }
  if (parsed.action === 'resume' && (!executor.handoff?.canResume || !executor.subAgentId)) {
    return toolResult(toolCallId, false, 'This Executor has no resumable durable context. Use restart or takeover.')
  }
  if (!executor.originalTask) {
    return toolResult(toolCallId, false, 'The original Executor task was not persisted; takeover is required.')
  }

  let attempt: ReturnType<typeof controller.startExecutor>
  try {
    attempt = controller.startExecutor(execution.executionId, executor.stepId)
  } catch (error) {
    return toolResult(toolCallId, false, error instanceof Error ? error.message : String(error))
  }
  const resume = parsed.action === 'resume'
  const subAgentId = resume
    ? executor.subAgentId!
    : `${executor.executorId}_${attempt.token.attemptId}`
  if (!resume) controller.setExecutorSubAgentId(execution.executionId, executor.executorId, subAgentId)

  const stopFromParent = () => controller.stopExecution(
    execution.executionId,
    'The parent Agent stopped while recovering an Executor.'
  )
  parentSignal?.addEventListener('abort', stopFromParent, { once: true })

  callbacks.onSubAgentStart?.(subAgentId, {
    type: 'Executor',
    description: `${parsed.action}: ${executor.stepId}`,
    prompt: executor.originalTask,
    context: executor.suppliedContext,
    parentToolCallId: toolCallId
  })

  try {
    const result = await SubAgentManager.spawn('Executor', {
      workspaceRoot: executor.worktreePath || config.workspaceRoot,
      sessionId,
      providerId: config.providerId,
      task: executor.originalTask,
      parentPrompt: executor.originalTask,
      context: executor.suppliedContext,
      subAgentId,
      resumeSubAgentId: resume ? executor.subAgentId : undefined,
      parentSignal: attempt.signal,
      controlToken: attempt.token,
      contextCapabilities: config.contextCapabilities,
      runtimeCoordinator: config.runtimeCoordinator,
      contextBuilder: config.contextBuilder,
      compactionService: config.compactionService,
      permissionScope: execution.isolation === 'worktree'
        ? { allowAllWritesInWorkspace: true, allowBash: true }
        : { allowedWriteFiles: executor.assignedFiles || [], allowBash: false },
      transactionId: execution.isolation === 'shared' ? parentTransaction?.id : undefined,
      editTransactionService: execution.isolation === 'shared' ? parentTransaction?.service : undefined,
      apiConfig: {
        baseUrl: config.baseUrl || '',
        apiKey: config.apiKey || '',
        apiFormat: config.apiFormat || 'openai',
        model: config.model || '',
        thinking: config.thinking,
        contextWindowTokens: config.contextCapabilities?.contextWindowTokens,
        maxInputTokens: config.contextCapabilities?.maxInputTokens,
        maxOutputTokens: config.contextCapabilities?.maxOutputTokens,
        reasoningCountsAgainstContext: config.contextCapabilities?.reasoningCountsAgainstContext
      }
    }, callbacks)

    const output = normalizeWorkerResult(result)
    const stepResult: StepResult = {
      stepId: executor.stepId,
      executorId: executor.executorId,
      attemptId: attempt.token.attemptId,
      status: output.status,
      summary: output.summary,
      filesModified: output.filesModified,
      error: output.status === 'completed' ? undefined : output.blockers?.join('; ') || `Executor ${output.status}`,
      failureReason: failureReasonFromResult(result),
      handoff: result.handoff,
      worktreePath: executor.worktreePath
    }
    controller.finishExecutor(execution.executionId, executor.stepId, stepResult)

    if (stepResult.status === 'completed' && executor.worktreePath) {
      const metadata = WorktreeService.list(config.workspaceRoot).find((item) =>
        path.resolve(item.path) === path.resolve(executor.worktreePath!)
      )
      const name = path.basename(executor.worktreePath)
      const mergeError = metadata?.branch
        ? await mergeWorktreeTracked(
            config.workspaceRoot,
            name,
            executor.worktreePath,
            metadata.branch,
            parentTransaction,
            parentSignal
          )
        : 'worktree metadata was not found'
      if (mergeError) {
        stepResult.status = 'failed'
        stepResult.failureReason = 'merge_conflict'
        stepResult.error = `merge conflict: ${mergeError}`
        stepResult.artifactStatus = 'merge_conflict'
      } else {
        try { WorktreeService.remove(config.workspaceRoot, name, true) } catch {}
        stepResult.worktreePath = undefined
        stepResult.artifactStatus = 'merged'
      }
      controller.reconcileExecutorResult(execution.executionId, stepResult)
    }

    const latest = controller.getExecution(execution.executionId)!
    if (latest.executors.every((item) => item.status === 'completed')) {
      controller.markExecutionTerminal(execution.executionId, 'completed')
    } else if (stepResult.status !== 'completed') {
      controller.markDecisionRequired(execution.executionId)
    }

    callbacks.onSubAgentEnd?.(subAgentId, {
      status: output.status,
      output: output.summary,
      qualitySummary: result.qualitySummary,
      toolCallCount: result.toolCallCount,
      filesExamined: result.filesExamined,
      conclusion: output.summary,
      handoff: result.handoff
    })
    return toolResult(toolCallId, stepResult.status === 'completed', {
      action: parsed.action,
      result: stepResult,
      execution: controller.getExecution(execution.executionId)
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const failed: StepResult = {
      stepId: executor.stepId,
      executorId: executor.executorId,
      attemptId: attempt.token.attemptId,
      status: 'failed',
      summary: '',
      filesModified: [],
      failureReason: 'runtime_error',
      error: reason,
      worktreePath: executor.worktreePath
    }
    controller.finishExecutor(execution.executionId, executor.stepId, failed)
    controller.markDecisionRequired(execution.executionId)
    callbacks.onSubAgentEnd?.(subAgentId, { status: 'failed', output: reason, toolCallCount: 0 })
    return toolResult(toolCallId, false, { action: parsed.action, result: failed })
  } finally {
    parentSignal?.removeEventListener('abort', stopFromParent)
  }
}
