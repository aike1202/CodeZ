import { randomUUID } from 'crypto'
import type { ContextScopeId } from '../../../shared/types/context'
import { contextScopeForSubAgent, MAIN_CONTEXT_SCOPE } from '../../../shared/types/context'
import type {
  AgentMailboxMessage,
  AgentRecord,
  AgentRuntimeSnapshot
} from '../../../shared/types/subagent'
import type { AgentRunConfig, AgentRunnerCallbacks } from '../../agent/AgentRunner/types'
import {
  SubAgentManager,
  type SubAgentPermissionScope,
  type SubAgentResult
} from '../../agent/SubAgentManager'
import type { EditTransactionService } from '../EditTransactionService'
import { AgentMailbox, type AgentMailboxPersistence } from './AgentMailbox'
import { AgentRegistry, type AgentRegistryPersistence } from './AgentRegistry'

export interface AgentLaunchEnvironment {
  config: AgentRunConfig
  callbacks: AgentRunnerCallbacks
  parentSignal?: AbortSignal
  parentContextScopeId?: ContextScopeId
  parentToolCallId?: string
  parentTransaction?: { id: string; service: EditTransactionService }
}

export interface SpawnAgentInput {
  type: string
  taskName: string
  description: string
  message: string
  context?: string
  expectations?: { questions: string[]; outOfScope?: string[] }
  scope?: { directories?: string[]; excludeGlobs?: string[] }
  depth?: 'quick' | 'normal' | 'exhaustive'
  permissionScope?: SubAgentPermissionScope
}

interface RunInput extends SpawnAgentInput {
  continuationMode?: 'followup'
}

export interface AgentWaitResult {
  messages: AgentMailboxMessage[]
  outcome: 'updated' | 'no_active_agents' | 'timeout'
}

const ROOT_AGENT_PATH = '/root'

function validateTaskName(taskName: string): string {
  const value = taskName.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new Error('task_name must be 1-64 ASCII letters, digits, underscores, or hyphens.')
  }
  return value
}

function validateMessage(message: string, fieldName = 'message'): string {
  if (!message.trim()) throw new Error(`${fieldName} must not be empty.`)
  return message
}

function resultSnapshot(result: SubAgentResult): NonNullable<AgentRecord['result']> {
  const report = result.structuredOutput?.report || [
    `## SubAgent ${result.status}`,
    '',
    result.output || 'No report was produced.'
  ].join('\n')
  return {
    status: result.status,
    report,
    conclusion: result.structuredOutput?.conclusion,
    qualitySummary: result.qualitySummary ? { ...result.qualitySummary } : undefined,
    toolCallCount: result.toolCallCount,
    filesExamined: [...(result.filesExamined || [])],
    handoff: result.handoff ? { ...result.handoff } : undefined
  }
}

export function formatAgentMessageForModel(message: AgentMailboxMessage): string {
  return [
    `<agent_message type="${message.type}" author="${message.author}" recipient="${message.recipient}">`,
    `Message Type: ${message.type}`,
    `Task name: ${message.recipient}`,
    `Sender: ${message.author}`,
    'Payload:',
    message.payload,
    '</agent_message>'
  ].join('\n')
}

export class AgentCollaborationRuntime {
  readonly registry = new AgentRegistry()
  readonly mailbox = new AgentMailbox()
  private readonly activeRuns = new Map<string, Promise<void>>()

  configurePersistence(persistence: AgentRegistryPersistence & AgentMailboxPersistence): void {
    this.registry.configurePersistence(persistence)
    this.mailbox.configurePersistence(persistence)
  }

  async restoreSession(sessionId: string, snapshot?: AgentRuntimeSnapshot): Promise<void> {
    const interruptedOnRestore = (snapshot?.agents || [])
      .filter((agent) => agent.status === 'queued' || agent.status === 'running')
      .map((agent) => agent.id)
    this.mailbox.restoreSession(sessionId, snapshot?.messages || [])
    await this.registry.restoreSession(sessionId, snapshot?.agents || [])
    for (const agentId of interruptedOnRestore) {
      const record = this.registry.get(agentId)
      if (!record?.result) continue
      const alreadyReported = this.mailbox.list(sessionId).some((message) =>
        message.type === 'FINAL_ANSWER' &&
        message.author === record.path &&
        message.recipient === record.parentPath &&
        message.createdAt >= (record.startedAt || record.createdAt)
      )
      if (alreadyReported) continue
      await this.mailbox.post({
        sessionId,
        type: 'FINAL_ANSWER',
        author: record.path,
        recipient: record.parentPath,
        payload: record.result.report
      })
    }
  }

  async spawn(input: SpawnAgentInput, environment: AgentLaunchEnvironment): Promise<AgentRecord> {
    const sessionId = environment.config.sessionId || 'session_default'
    const definition = SubAgentManager.getDefinition(input.type)
    if (!definition) throw new Error(`Unknown subagent type '${input.type}'.`)
    if (!SubAgentManager.isEnabled(input.type)) throw new Error(`SubAgent type '${input.type}' is disabled.`)

    const taskName = validateTaskName(input.taskName)
    validateMessage(input.message)
    const parent = this.resolveParent(sessionId, environment.parentContextScopeId)
    const id = `agent_${randomUUID()}`
    const now = Date.now()
    const record: AgentRecord = {
      id,
      sessionId,
      parentAgentId: parent.id,
      parentPath: parent.path,
      path: `${parent.path}/${taskName}`,
      type: definition.type,
      taskName,
      description: input.description.trim() || input.message.slice(0, 120),
      status: 'queued',
      contextScopeId: contextScopeForSubAgent(id) as `subagent:${string}`,
      createdAt: now,
      updatedAt: now,
      runCount: 1,
      launch: {
        context: input.context,
        expectations: input.expectations,
        scope: input.scope,
        depth: input.depth,
        permissionScope: input.permissionScope
      }
    }

    await this.registry.create(record)
    await this.mailbox.post({
      sessionId,
      type: 'NEW_TASK',
      author: parent.path,
      recipient: record.path,
      payload: input.message,
      delivered: true
    })
    this.startRun(record, input, environment)
    return record
  }

  async followup(
    target: string,
    message: string,
    environment: AgentLaunchEnvironment
  ): Promise<AgentRecord> {
    const sessionId = environment.config.sessionId || 'session_default'
    const record = this.registry.resolve(sessionId, target)
    if (!record) throw new Error(`Unknown agent target: ${target}`)
    validateMessage(message)
    if (record.status === 'queued' || record.status === 'running') {
      throw new Error(`Agent is already running: ${record.path}`)
    }
    const input: RunInput = {
      type: record.type,
      taskName: record.taskName,
      description: message.slice(0, 120),
      message,
      context: record.launch?.context,
      expectations: record.launch?.expectations,
      scope: record.launch?.scope,
      depth: record.launch?.depth,
      permissionScope: record.launch?.permissionScope,
      continuationMode: 'followup'
    }
    await this.registry.update(record.id, {
      status: 'queued',
      description: input.description,
      completedAt: undefined,
      result: undefined,
      runCount: record.runCount + 1
    })
    await this.mailbox.post({
      sessionId,
      type: 'NEW_TASK',
      author: this.resolveParent(sessionId, environment.parentContextScopeId).path,
      recipient: record.path,
      payload: message,
      delivered: true
    })
    this.startRun(record, input, environment)
    return this.registry.get(record.id)!
  }

  async sendMessage(input: {
    sessionId: string
    senderContextScopeId?: ContextScopeId
    target: string
    message: string
  }): Promise<AgentMailboxMessage> {
    validateMessage(input.message)
    const author = this.resolveParent(input.sessionId, input.senderContextScopeId).path
    const recipient = input.target === ROOT_AGENT_PATH
      ? ROOT_AGENT_PATH
      : this.requireAgent(input.sessionId, input.target).path
    return this.mailbox.post({
      sessionId: input.sessionId,
      type: 'MESSAGE',
      author,
      recipient,
      payload: input.message
    })
  }

  async waitForUpdate(
    sessionId: string,
    recipient: string,
    timeoutMs: number,
    targets?: readonly string[]
  ): Promise<AgentWaitResult> {
    const requestedTargets = targets?.filter((target) => target.trim())
    const targetRecords = requestedTargets?.length
      ? requestedTargets.map((target) => this.requireAgent(sessionId, target))
      : undefined
    const authors = targetRecords?.map((record) => record.path)
    const unread = this.mailbox.peekUnread(sessionId, recipient, authors)
    if (unread.length > 0) return { messages: unread, outcome: 'updated' }

    const active = targetRecords || this.registry.listByStatus(sessionId, ['queued', 'running'])
    if (!active.some((record) => record.status === 'queued' || record.status === 'running')) {
      return { messages: [], outcome: 'no_active_agents' }
    }

    const messages = await this.mailbox.waitForUnread(sessionId, recipient, timeoutMs, authors)
    if (messages.length > 0) return { messages, outcome: 'updated' }

    const stillActive = targetRecords
      ? targetRecords.some((record) => {
          const latest = this.registry.get(record.id)
          return latest?.status === 'queued' || latest?.status === 'running'
        })
      : this.registry.listByStatus(sessionId, ['queued', 'running']).length > 0
    return {
      messages: [],
      outcome: stillActive ? 'timeout' : 'no_active_agents'
    }
  }

  async consumeForAgent(sessionId: string, recipient: string): Promise<string[]> {
    const messages = await this.mailbox.consume(sessionId, recipient)
    return messages.map(formatAgentMessageForModel)
  }

  interrupt(sessionId: string, target: string): boolean {
    return this.registry.interrupt(sessionId, target)
  }

  list(sessionId: string): AgentRecord[] {
    return this.registry.list(sessionId)
  }

  pathForContext(sessionId: string, contextScopeId?: ContextScopeId): string {
    return this.resolveParent(sessionId, contextScopeId).path
  }

  removeSession(sessionId: string): void {
    this.registry.removeSession(sessionId)
    this.mailbox.removeSession(sessionId)
  }

  private startRun(
    record: AgentRecord,
    input: RunInput,
    environment: AgentLaunchEnvironment
  ): void {
    const promise = this.runAgent(record.id, input, environment)
      .catch(() => undefined)
      .finally(() => this.activeRuns.delete(record.id))
    this.activeRuns.set(record.id, promise)
  }

  private async runAgent(
    agentId: string,
    input: RunInput,
    environment: AgentLaunchEnvironment
  ): Promise<void> {
    const record = this.registry.get(agentId)
    if (!record) return
    const controller = new AbortController()
    const abortFromParent = () => controller.abort(environment.parentSignal?.reason)
    environment.parentSignal?.addEventListener('abort', abortFromParent, { once: true })
    this.registry.attachCanceller(agentId, () => controller.abort('The parent interrupted this SubAgent.'))

    try {
      await this.registry.update(agentId, { status: 'running', startedAt: Date.now() })
      environment.callbacks.onSubAgentStart?.(agentId, {
        type: record.type,
        description: input.description,
        prompt: input.message,
        depth: input.depth,
        expectations: input.expectations,
        context: input.context,
        scope: input.scope,
        parentToolCallId: environment.parentToolCallId || agentId
      })
      const definition = SubAgentManager.getDefinition(record.type)!
      const result = await SubAgentManager.spawn(record.type, {
        workspaceRoot: environment.config.workspaceRoot,
        sessionId: record.sessionId,
        providerId: environment.config.providerId,
        task: input.message,
        parentPrompt: input.message,
        subAgentId: agentId,
        resumeSubAgentId: input.continuationMode ? agentId : undefined,
        continuationMode: input.continuationMode,
        expectations: input.expectations,
        context: input.context,
        scope: input.scope,
        depth: input.depth,
        contextCapabilities: environment.config.contextCapabilities,
        runtimeCoordinator: environment.config.runtimeCoordinator,
        contextBuilder: environment.config.contextBuilder,
        compactionService: environment.config.compactionService,
        parentSignal: controller.signal,
        permissionScope: input.permissionScope || (definition.allowShell
          ? { allowBash: true, allowedWriteFiles: [], shellPolicy: definition.shellPolicy }
          : undefined),
        transactionId: environment.parentTransaction?.id,
        editTransactionService: environment.parentTransaction?.service,
        consumeAgentMessages: () => this.consumeForAgent(record.sessionId, record.path),
        apiConfig: {
          baseUrl: environment.config.baseUrl || '',
          apiKey: environment.config.apiKey || '',
          apiFormat: environment.config.apiFormat || 'openai',
          model: environment.config.model || '',
          thinking: environment.config.thinking,
          contextWindowTokens: environment.config.contextCapabilities?.contextWindowTokens,
          maxInputTokens: environment.config.contextCapabilities?.maxInputTokens,
          maxOutputTokens: environment.config.contextCapabilities?.maxOutputTokens,
          reasoningCountsAgainstContext: environment.config.contextCapabilities?.reasoningCountsAgainstContext
        }
      }, environment.callbacks)
      const completedAt = Date.now()
      const snapshot = resultSnapshot(result)
      await this.registry.update(agentId, {
        status: result.status,
        completedAt,
        result: snapshot
      })
      await this.mailbox.post({
        sessionId: record.sessionId,
        type: 'FINAL_ANSWER',
        author: record.path,
        recipient: record.parentPath,
        payload: snapshot.report
      })
      environment.callbacks.onSubAgentEnd?.(agentId, {
        status: result.status,
        output: result.output,
        qualitySummary: result.qualitySummary,
        toolCallCount: result.toolCallCount,
        filesExamined: result.filesExamined,
        conclusion: result.structuredOutput?.conclusion,
        handoff: result.handoff
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const status = controller.signal.aborted ? 'interrupted' : 'failed'
      await this.registry.update(agentId, {
        status,
        completedAt: Date.now(),
        result: {
          status,
          report: `## SubAgent ${status}\n\n${reason}`,
          conclusion: 'The SubAgent did not complete successfully.',
          toolCallCount: 0,
          filesExamined: []
        }
      })
      await this.mailbox.post({
        sessionId: record.sessionId,
        type: 'FINAL_ANSWER',
        author: record.path,
        recipient: record.parentPath,
        payload: `## SubAgent ${status}\n\n${reason}`
      })
      environment.callbacks.onSubAgentEnd?.(agentId, {
        status,
        output: reason,
        toolCallCount: 0
      })
    } finally {
      environment.parentSignal?.removeEventListener('abort', abortFromParent)
      this.registry.detachCanceller(agentId)
    }
  }

  private resolveParent(
    sessionId: string,
    contextScopeId: ContextScopeId | undefined
  ): { id: string; path: string } {
    if (!contextScopeId || contextScopeId === MAIN_CONTEXT_SCOPE) {
      return { id: ROOT_AGENT_PATH, path: ROOT_AGENT_PATH }
    }
    const id = contextScopeId.startsWith('subagent:')
      ? contextScopeId.slice('subagent:'.length)
      : contextScopeId
    const record = this.registry.get(id)
    return record && record.sessionId === sessionId
      ? { id: record.id, path: record.path }
      : { id: ROOT_AGENT_PATH, path: ROOT_AGENT_PATH }
  }

  private requireAgent(sessionId: string, target: string): AgentRecord {
    const record = this.registry.resolve(sessionId, target)
    if (!record) throw new Error(`Unknown agent target: ${target}`)
    return record
  }
}

let runtime: AgentCollaborationRuntime | undefined

export function getAgentCollaborationRuntime(): AgentCollaborationRuntime {
  runtime ??= new AgentCollaborationRuntime()
  return runtime
}

export function resetAgentCollaborationRuntimeForTests(): void {
  runtime = undefined
}
