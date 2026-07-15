import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs'
import path from 'path'
import type {
  ExecutionRuntimeStatus,
  ExecutorControlToken,
  ExecutorFailureReason,
  ExecutorRuntimeSnapshot,
  ExecutorRuntimeStatus,
  ExecutionWave,
  ParallelExecutionEvent,
  ParallelExecutionSnapshot,
  StepResult
} from '../../../shared/types/parallel'

interface ActiveAttempt {
  controller: AbortController
  token: ExecutorControlToken
}

interface ExecutionRuntime {
  workspaceRoot: string
  snapshot: ParallelExecutionSnapshot
  activeAttempts: Map<string, ActiveAttempt>
  artifactHandlers: Map<string, () => Promise<string | null>>
  parentAbortCleanup?: () => void
}

export interface CreateExecutionInput {
  workspaceRoot: string
  sessionId: string
  source: string
  parentToolCallId?: string
  waves: ExecutionWave[]
  isolation: 'shared' | 'worktree'
  rationale: string
  stepTitles?: Record<string, string>
  executorDefinitions?: Record<string, {
    task: string
    context?: string
    assignedFiles?: string[]
  }>
  parentSignal?: AbortSignal
  executionId?: string
}

export interface StartExecutorAttemptResult {
  token: ExecutorControlToken
  signal: AbortSignal
  snapshot: ExecutorRuntimeSnapshot
}

type ExecutionListener = (event: ParallelExecutionEvent) => void

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

function cloneSnapshot(snapshot: ParallelExecutionSnapshot): ParallelExecutionSnapshot {
  return structuredClone(snapshot)
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96) || 'unknown'
}

/**
 * Authoritative in-process control plane for parallel Executor lifecycles.
 * Runtime handles are intentionally kept outside the serializable snapshot.
 */
export class ExecutionController {
  private readonly executions = new Map<string, ExecutionRuntime>()
  private readonly listeners = new Set<ExecutionListener>()

  createExecution(input: CreateExecutionInput): ParallelExecutionSnapshot {
    const executionId = input.executionId || makeId('exec')
    const existing = this.executions.get(executionId)
    if (existing) return cloneSnapshot(existing.snapshot)

    const now = Date.now()
    const executors: ExecutorRuntimeSnapshot[] = []
    const seen = new Set<string>()
    for (const wave of input.waves) {
      for (const stepId of wave.stepIds) {
        if (seen.has(stepId)) {
          throw new Error(`Duplicate step id '${stepId}' in parallel execution.`)
        }
        seen.add(stepId)
        executors.push({
          executorId: `executor_${safeSegment(executionId)}_${safeSegment(stepId)}`,
          subAgentId: `executor_${safeSegment(executionId)}_${safeSegment(stepId)}`,
          stepId,
          waveIndex: wave.index,
          status: 'queued',
          attemptCount: 0,
          filesModified: [],
          filesPossiblyModified: [],
          artifactStatus: 'none',
          assignedFiles: [...(input.executorDefinitions?.[stepId]?.assignedFiles || [])],
          originalTask: input.executorDefinitions?.[stepId]?.task,
          suppliedContext: input.executorDefinitions?.[stepId]?.context
        })
      }
    }

    const snapshot: ParallelExecutionSnapshot = {
      executionId,
      sessionId: input.sessionId,
      source: input.source,
      parentToolCallId: input.parentToolCallId,
      status: 'planned',
      controlEpoch: 0,
      isolation: input.isolation,
      rationale: input.rationale,
      waves: input.waves.map((wave) => ({ ...wave, stepIds: [...wave.stepIds] })),
      executors,
      sequence: 0,
      createdAt: now,
      updatedAt: now
    }
    const runtime: ExecutionRuntime = {
      workspaceRoot: input.workspaceRoot,
      snapshot,
      activeAttempts: new Map(),
      artifactHandlers: new Map()
    }
    this.executions.set(executionId, runtime)

    if (input.parentSignal) {
      const stopFromParent = () => {
        this.stopExecution(executionId, 'The parent Agent run was interrupted.')
      }
      input.parentSignal.addEventListener('abort', stopFromParent, { once: true })
      runtime.parentAbortCleanup = () => input.parentSignal?.removeEventListener('abort', stopFromParent)
      if (input.parentSignal.aborted) stopFromParent()
    }

    this.commit(runtime, 'created')
    return cloneSnapshot(runtime.snapshot)
  }

  startExecution(executionId: string): ParallelExecutionSnapshot {
    const runtime = this.requireRuntime(executionId)
    if (runtime.snapshot.status === 'planned') {
      runtime.snapshot.status = 'running'
      this.commit(runtime, 'updated')
    }
    return cloneSnapshot(runtime.snapshot)
  }

  startExecutor(executionId: string, stepId: string): StartExecutorAttemptResult {
    const runtime = this.requireRuntime(executionId)
    if (!['planned', 'running', 'decision_required', 'halted', 'stopped'].includes(runtime.snapshot.status)) {
      throw new Error(`Execution '${executionId}' cannot start an Executor while ${runtime.snapshot.status}.`)
    }
    const executor = this.requireExecutor(runtime, stepId)
    if (runtime.activeAttempts.has(executor.executorId)) {
      throw new Error(`Executor '${executor.executorId}' already has an active attempt.`)
    }

    const controller = new AbortController()
    const attemptId = makeId(`attempt_${safeSegment(stepId)}`)
    const token: ExecutorControlToken = {
      executionId,
      executorId: executor.executorId,
      attemptId,
      leaseId: makeId('lease'),
      controlEpoch: runtime.snapshot.controlEpoch
    }
    runtime.activeAttempts.set(executor.executorId, { controller, token })
    executor.status = 'running'
    executor.attemptId = attemptId
    executor.attemptCount += 1
    executor.leaseId = token.leaseId
    executor.lastHeartbeatAt = Date.now()
    executor.error = undefined
    executor.failureReason = undefined
    runtime.snapshot.status = 'running'
    this.commit(runtime, 'updated')
    return { token, signal: controller.signal, snapshot: structuredClone(executor) }
  }

  heartbeat(token: ExecutorControlToken): boolean {
    const denial = this.assertLeaseActive(token)
    if (denial) return false
    const runtime = this.requireRuntime(token.executionId)
    const executor = this.requireExecutorById(runtime, token.executorId)
    executor.lastHeartbeatAt = Date.now()
    this.commit(runtime, 'updated')
    return true
  }

  finishExecutor(executionId: string, stepId: string, result: StepResult): boolean {
    const runtime = this.requireRuntime(executionId)
    const executor = this.requireExecutor(runtime, stepId)
    const active = runtime.activeAttempts.get(executor.executorId)
    if (!active || (result.attemptId && active.token.attemptId !== result.attemptId)) {
      return false
    }
    runtime.activeAttempts.delete(executor.executorId)
    executor.status = result.status === 'completed'
      ? 'completed'
      : result.status === 'interrupted'
        ? 'interrupted'
        : 'failed'
    executor.summary = result.summary
    executor.error = result.error
    executor.failureReason = result.failureReason
    executor.filesModified = [...result.filesModified]
    executor.filesPossiblyModified = [...(result.handoff?.filesPossiblyModified || [])]
    executor.worktreePath = result.worktreePath
    executor.handoff = result.handoff
    executor.artifactStatus = result.artifactStatus || executor.artifactStatus
    executor.artifactCommit = result.artifactCommit || executor.artifactCommit
    executor.leaseId = undefined
    executor.lastHeartbeatAt = Date.now()
    this.commit(runtime, 'updated')
    return true
  }

  /**
   * Preserve resumability after stopExecution revoked the attempt before the
   * SubAgent finished writing its interrupted handoff. This never accepts a
   * late completion or restores execution authority.
   */
  recordInterruptedHandoff(executionId: string, stepId: string, result: StepResult): boolean {
    if (result.status !== 'interrupted' || !result.handoff?.canResume || !result.attemptId) {
      return false
    }
    const runtime = this.requireRuntime(executionId)
    const executor = this.requireExecutor(runtime, stepId)
    if (
      runtime.activeAttempts.has(executor.executorId) ||
      executor.attemptId !== result.attemptId ||
      !executor.subAgentId ||
      ['completed', 'succeeded', 'taken_over'].includes(executor.status)
    ) {
      return false
    }

    executor.handoff = structuredClone(result.handoff)
    executor.summary = result.summary || executor.summary
    executor.error = result.error || executor.error
    executor.failureReason = result.failureReason || executor.failureReason
    executor.filesModified = [...new Set([...executor.filesModified, ...result.filesModified])]
    executor.filesPossiblyModified = [...new Set([
      ...executor.filesPossiblyModified,
      ...(result.handoff.filesPossiblyModified || [])
    ])]
    executor.lastHeartbeatAt = Date.now()
    this.commit(runtime, 'updated')
    return true
  }

  failExecutorBeforeStart(
    executionId: string,
    stepId: string,
    error: string,
    failureReason: ExecutorFailureReason = 'runtime_error'
  ): ExecutorRuntimeSnapshot {
    const runtime = this.requireRuntime(executionId)
    const executor = this.requireExecutor(runtime, stepId)
    if (executor.status !== 'queued') return structuredClone(executor)
    executor.status = 'failed'
    executor.error = error
    executor.failureReason = failureReason
    executor.summary = ''
    this.commit(runtime, 'updated')
    return structuredClone(executor)
  }

  reconcileExecutorResult(executionId: string, result: StepResult): ExecutorRuntimeSnapshot {
    const runtime = this.requireRuntime(executionId)
    const executor = this.requireExecutor(runtime, result.stepId)
    if (
      runtime.snapshot.status === 'stopped' ||
      runtime.snapshot.status === 'cancelled' ||
      executor.status === 'stopped' ||
      executor.status === 'taken_over' ||
      executor.status === 'lost' ||
      (
        result.attemptId !== undefined &&
        executor.attemptId !== undefined &&
        result.attemptId !== executor.attemptId
      )
    ) {
      return structuredClone(executor)
    }
    executor.status = result.status === 'completed'
      ? result.artifactStatus === 'ready' ? 'succeeded' : 'completed'
      : result.status === 'interrupted'
        ? 'interrupted'
        : 'failed'
    executor.summary = result.summary
    executor.error = result.error
    executor.failureReason = result.failureReason
    executor.filesModified = [...result.filesModified]
    executor.filesPossiblyModified = [...(result.handoff?.filesPossiblyModified || executor.filesPossiblyModified)]
    executor.worktreePath = result.worktreePath
    executor.handoff = result.handoff || executor.handoff
    executor.artifactStatus = result.artifactStatus || executor.artifactStatus
    executor.artifactCommit = result.artifactCommit || executor.artifactCommit
    this.commit(runtime, 'updated')
    return structuredClone(executor)
  }

  setExecutorSubAgentId(executionId: string, executorId: string, subAgentId: string): void {
    const runtime = this.requireRuntime(executionId)
    const executor = this.requireExecutorById(runtime, executorId)
    if (executor.subAgentId !== subAgentId) executor.handoff = undefined
    executor.subAgentId = subAgentId
    this.commit(runtime, 'updated')
  }

  registerArtifact(
    executionId: string,
    executorId: string,
    handler: () => Promise<string | null>
  ): void {
    const runtime = this.requireRuntime(executionId)
    const executor = this.requireExecutorById(runtime, executorId)
    runtime.artifactHandlers.set(executorId, handler)
    executor.status = 'succeeded'
    executor.artifactStatus = 'ready'
    this.commit(runtime, 'updated')
  }

  async acceptCompleted(executionId: string, executorId?: string): Promise<ParallelExecutionSnapshot> {
    const runtime = this.requireRuntime(executionId)
    const targets = executorId
      ? [this.requireExecutorById(runtime, executorId)]
      : runtime.snapshot.executors.filter((executor) => executor.artifactStatus === 'ready')
    if (targets.length === 0) throw new Error('No ready Executor artifacts were found.')
    if (targets.some((executor) => executor.artifactStatus !== 'ready')) {
      throw new Error(`Executor '${executorId}' has no ready artifact.`)
    }

    for (const executor of targets) {
      const handler = runtime.artifactHandlers.get(executor.executorId)
      if (!handler) {
        throw new Error(`Artifact '${executor.executorId}' cannot be merged after Runtime restart; takeover is required.`)
      }
      executor.artifactStatus = 'merging'
      this.commit(runtime, 'updated')
      const error = await handler()
      if (error) {
        executor.status = 'failed'
        executor.artifactStatus = 'merge_conflict'
        executor.failureReason = 'merge_conflict'
        executor.error = error
        this.commit(runtime, 'updated')
        throw new Error(error)
      }
      runtime.artifactHandlers.delete(executor.executorId)
      executor.status = 'completed'
      executor.artifactStatus = 'merged'
      executor.worktreePath = undefined
      this.commit(runtime, 'updated')
    }
    if (runtime.snapshot.executors.every((executor) => executor.status === 'completed')) {
      runtime.snapshot.status = 'completed'
      runtime.parentAbortCleanup?.()
      runtime.parentAbortCleanup = undefined
      this.commit(runtime, 'terminal')
    } else if (runtime.snapshot.status !== 'stopped') {
      runtime.snapshot.status = 'decision_required'
      this.commit(runtime, 'updated')
    }
    return cloneSnapshot(runtime.snapshot)
  }

  stopExecutor(executionId: string, executorId: string, reason = 'Executor stopped by the main Agent.'): ParallelExecutionSnapshot {
    const runtime = this.requireRuntime(executionId)
    const executor = this.requireExecutorById(runtime, executorId)
    const active = runtime.activeAttempts.get(executorId)
    if (active) {
      runtime.activeAttempts.delete(executorId)
      active.controller.abort(reason)
    }
    if (!['succeeded', 'completed', 'failed', 'taken_over'].includes(executor.status)) {
      executor.status = 'stopped'
      executor.error = reason
      executor.failureReason = 'user_stopped'
      executor.leaseId = undefined
    }
    this.commit(runtime, 'updated')
    return cloneSnapshot(runtime.snapshot)
  }

  stopExecution(executionId: string, reason = 'Execution stopped by the main Agent.'): ParallelExecutionSnapshot {
    const runtime = this.requireRuntime(executionId)
    if (['stopped', 'completed', 'cancelled'].includes(runtime.snapshot.status)) {
      return cloneSnapshot(runtime.snapshot)
    }
    runtime.snapshot.status = 'stopping'
    runtime.snapshot.controlEpoch += 1
    for (const [executorId, active] of runtime.activeAttempts) {
      active.controller.abort(reason)
      const executor = this.requireExecutorById(runtime, executorId)
      executor.status = 'stopped'
      executor.error = reason
      executor.failureReason = 'user_stopped'
      executor.leaseId = undefined
    }
    runtime.activeAttempts.clear()
    for (const executor of runtime.snapshot.executors) {
      if (executor.status === 'queued') executor.status = 'stopped'
    }
    runtime.snapshot.status = 'stopped'
    this.commit(runtime, 'terminal')
    return cloneSnapshot(runtime.snapshot)
  }

  takeover(executionId: string, executorId: string): ParallelExecutionSnapshot {
    this.stopExecutor(executionId, executorId, 'Executor authority was transferred to the main Agent.')
    const runtime = this.requireRuntime(executionId)
    const executor = this.requireExecutorById(runtime, executorId)
    executor.status = 'taken_over'
    this.commit(runtime, 'updated')
    return cloneSnapshot(runtime.snapshot)
  }

  markExecutionTerminal(executionId: string, status: 'completed' | 'halted' | 'stopped'): ParallelExecutionSnapshot {
    const runtime = this.requireRuntime(executionId)
    if (runtime.snapshot.status === 'stopped' && status !== 'stopped') {
      return cloneSnapshot(runtime.snapshot)
    }
    runtime.snapshot.status = status
    runtime.parentAbortCleanup?.()
    runtime.parentAbortCleanup = undefined
    this.commit(runtime, 'terminal')
    return cloneSnapshot(runtime.snapshot)
  }

  markDecisionRequired(executionId: string): ParallelExecutionSnapshot {
    const runtime = this.requireRuntime(executionId)
    if (runtime.snapshot.status !== 'stopped') {
      runtime.snapshot.status = 'decision_required'
      this.commit(runtime, 'updated')
    }
    return cloneSnapshot(runtime.snapshot)
  }

  assertLeaseActive(token: ExecutorControlToken): string | null {
    const runtime = this.executions.get(token.executionId)
    if (!runtime) return `Execution '${token.executionId}' no longer exists.`
    if (runtime.snapshot.controlEpoch !== token.controlEpoch) return 'Executor control epoch is stale.'
    if (!['planned', 'running', 'decision_required'].includes(runtime.snapshot.status)) {
      return `Execution is ${runtime.snapshot.status}; new tool calls are denied.`
    }
    const active = runtime.activeAttempts.get(token.executorId)
    if (!active) return 'Executor lease has been revoked.'
    if (
      active.token.attemptId !== token.attemptId ||
      active.token.leaseId !== token.leaseId
    ) {
      return 'Executor lease does not match the active attempt.'
    }
    return null
  }

  getExecution(executionId: string): ParallelExecutionSnapshot | undefined {
    const runtime = this.executions.get(executionId)
    return runtime ? cloneSnapshot(runtime.snapshot) : undefined
  }

  listSession(sessionId: string): ParallelExecutionSnapshot[] {
    return Array.from(this.executions.values())
      .filter((runtime) => runtime.snapshot.sessionId === sessionId)
      .map((runtime) => cloneSnapshot(runtime.snapshot))
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  restoreSession(workspaceRoot: string, sessionId: string): ParallelExecutionSnapshot[] {
    if (Array.from(this.executions.values()).some((runtime) => runtime.snapshot.sessionId === sessionId)) {
      return this.listSession(sessionId)
    }
    const directory = path.join(workspaceRoot, '.codez', 'executions', safeSegment(sessionId))
    if (!existsSync(directory)) return []

    for (const fileName of readdirSync(directory)) {
      if (!fileName.endsWith('.json')) continue
      try {
        const snapshot = JSON.parse(readFileSync(path.join(directory, fileName), 'utf8')) as ParallelExecutionSnapshot
        if (!snapshot.executionId || snapshot.sessionId !== sessionId) continue
        const runtime: ExecutionRuntime = {
          workspaceRoot,
          snapshot,
          activeAttempts: new Map(),
          artifactHandlers: new Map()
        }
        this.executions.set(snapshot.executionId, runtime)
        if (!['completed', 'stopped', 'cancelled', 'halted'].includes(snapshot.status)) {
          snapshot.status = 'decision_required'
          snapshot.controlEpoch += 1
          for (const executor of snapshot.executors) {
            if (executor.status === 'running' || executor.status === 'stopping') {
              executor.status = 'lost'
              executor.failureReason = 'runtime_missing'
              executor.error = 'Executor Runtime disappeared before a terminal result was delivered.'
              executor.leaseId = undefined
            }
          }
          this.commit(runtime, 'updated')
        }
      } catch {
        // Ignore one corrupt snapshot; other executions remain recoverable.
      }
    }
    return this.listSession(sessionId)
  }

  onEvent(listener: ExecutionListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  resetForTests(): void {
    for (const runtime of this.executions.values()) runtime.parentAbortCleanup?.()
    this.executions.clear()
    this.listeners.clear()
  }

  private commit(runtime: ExecutionRuntime, type: ParallelExecutionEvent['type']): void {
    runtime.snapshot.sequence += 1
    runtime.snapshot.updatedAt = Date.now()
    this.persist(runtime)
    const event: ParallelExecutionEvent = {
      sequence: runtime.snapshot.sequence,
      sessionId: runtime.snapshot.sessionId,
      executionId: runtime.snapshot.executionId,
      timestamp: runtime.snapshot.updatedAt,
      type,
      snapshot: cloneSnapshot(runtime.snapshot)
    }
    for (const listener of this.listeners) listener(event)
  }

  private persist(runtime: ExecutionRuntime): void {
    const directory = path.join(
      runtime.workspaceRoot,
      '.codez',
      'executions',
      safeSegment(runtime.snapshot.sessionId)
    )
    mkdirSync(directory, { recursive: true })
    const target = path.join(directory, `${safeSegment(runtime.snapshot.executionId)}.json`)
    const temporary = `${target}.tmp`
    writeFileSync(temporary, JSON.stringify(runtime.snapshot, null, 2), 'utf8')
    renameSync(temporary, target)
  }

  private requireRuntime(executionId: string): ExecutionRuntime {
    const runtime = this.executions.get(executionId)
    if (!runtime) throw new Error(`Unknown execution '${executionId}'.`)
    return runtime
  }

  private requireExecutor(runtime: ExecutionRuntime, stepId: string): ExecutorRuntimeSnapshot {
    const executor = runtime.snapshot.executors.find((item) => item.stepId === stepId)
    if (!executor) throw new Error(`Unknown step '${stepId}' in execution '${runtime.snapshot.executionId}'.`)
    return executor
  }

  private requireExecutorById(runtime: ExecutionRuntime, executorId: string): ExecutorRuntimeSnapshot {
    const executor = runtime.snapshot.executors.find((item) => item.executorId === executorId)
    if (!executor) throw new Error(`Unknown Executor '${executorId}' in execution '${runtime.snapshot.executionId}'.`)
    return executor
  }
}

let singleton: ExecutionController | undefined

export function getExecutionController(): ExecutionController {
  if (!singleton) singleton = new ExecutionController()
  return singleton
}
