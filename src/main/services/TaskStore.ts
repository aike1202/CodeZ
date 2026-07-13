import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import type {
  TaskApprovalStatus,
  TaskContextBundle,
  TaskExecutorRuntime,
  TaskItem,
  TaskRiskLevel,
  TaskStatus,
} from '../../shared/types/task'
import type {
  ExecutorRuntimeSnapshot,
  ParallelExecutionEvent,
  ParallelExecutionSnapshot,
} from '../../shared/types/parallel'
import type { SessionData } from '../../shared/types/session'
import { getSessionStore } from '../ipc/session.handlers'
import { getExecutionController } from './execution/ExecutionController'

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'cancelled'
}

function projectLogicalStatus(
  current: TaskStatus,
  execution: ParallelExecutionSnapshot,
  executor: ExecutorRuntimeSnapshot
): TaskStatus {
  switch (executor.status) {
    case 'completed':
      return execution.isolation === 'worktree' && executor.artifactStatus !== 'merged'
        ? 'in_progress'
        : 'completed'
    case 'running':
    case 'paused':
    case 'stopping':
    case 'succeeded':
    case 'taken_over':
      return 'in_progress'
    case 'queued':
      return isTerminalTaskStatus(current) ? current : 'pending'
    case 'stopped':
    case 'failed':
    case 'interrupted':
    case 'lost':
      return isTerminalTaskStatus(current) ? current : 'pending'
  }
}

function sameExecutorRuntime(
  left: TaskExecutorRuntime | undefined,
  right: Omit<TaskExecutorRuntime, 'updatedAt'>
): boolean {
  if (!left) return false
  return left.executionId === right.executionId &&
    left.executionCreatedAt === right.executionCreatedAt &&
    left.executorId === right.executorId &&
    left.waveIndex === right.waveIndex &&
    left.isolation === right.isolation &&
    left.status === right.status &&
    left.attemptCount === right.attemptCount &&
    left.summary === right.summary &&
    left.error === right.error &&
    left.failureReason === right.failureReason &&
    left.artifactStatus === right.artifactStatus &&
    left.detached === right.detached
}

/**
 * 轻量 Task 的存储（单例）。
 *
 * 内存为主（bySession），每次变更后同步写入 SessionData.tasks 字段，
 * 走 SessionStore.save() 落盘。进程重启 / 会话切换时从磁盘恢复。
 */
export class TaskStore {
  private static instance: TaskStore | null = null

  /** sessionId → 有序 Task 列表 */
  private bySession = new Map<string, TaskItem[]>()
  /** sessionId → 自增计数器（用于生成 t1/t2... 稳定 ID） */
  private counters = new Map<string, number>()
  private readonly executionListener = (event: ParallelExecutionEvent): void => {
    this.applyExecutionEvent(event)
  }

  static getInstance(): TaskStore {
    if (!this.instance) {
      this.instance = new TaskStore()
    }
    // ExecutionController uses a Set, so re-registering this stable callback is idempotent.
    // This also repairs the subscription after resetForTests() clears controller listeners.
    getExecutionController().onEvent(this.instance.executionListener)
    return this.instance
  }

  /** 返回某会话的 Task 列表（副本）。 */
  list(sessionId: string): TaskItem[] {
    return [...(this.bySession.get(sessionId) ?? [])]
  }

  getById(sessionId: string, taskId: string): TaskItem | undefined {
    return this.bySession.get(sessionId)?.find(t => t.id === taskId)
  }

  /** 从磁盘恢复整组 tasks 到内存（AgentRunner 启动时调用）。 */
  restore(sessionId: string, tasks: TaskItem[]): void {
    this.bySession.set(sessionId, [...tasks])
    const maxNum = tasks
      .map(t => parseInt(t.id.slice(1), 10))
      .filter(n => !isNaN(n))
      .reduce((max, n) => Math.max(max, n), 0)
    this.counters.set(sessionId, maxNum)
  }

  /** 生成下一个稳定 ID（t1, t2 ...）。 */
  private nextId(sessionId: string): string {
    const cur = this.counters.get(sessionId) ?? 0
    const next = cur + 1
    this.counters.set(sessionId, next)
    return `t${next}`
  }

  /** 变更后落盘：读 session → 设 tasks → 存回。 */
  private persist(sessionId: string): void {
    try {
      const store = getSessionStore() as { get(sessionId: string): SessionData | undefined; save(session: SessionData): Promise<void> }
      const session = store.get(sessionId)
      if (session) {
        session.tasks = this.list(sessionId)
        store.save(session)
      }
    } catch {
      // session handler 未初始化时静默失败
    }
  }

  /**
   * 批量创建 Task。返回创建后的完整列表。
   * 每个 Task 分配稳定 ID，初始 status='pending'。
   */
  create(
    sessionId: string,
    items: Array<{
      subject: string
      description?: string
      files?: string[]
      activeForm?: string
      title?: string
      subtitle?: string
      groupId?: string
      groupTitle?: string
      groupSubtitle?: string
      riskLevel?: TaskRiskLevel
      requiresApproval?: boolean
      approvalStatus?: TaskApprovalStatus
      acceptanceCriteria?: string[]
      verificationCommand?: string
      contextBundle?: TaskContextBundle
    }>
  ): TaskItem[] {
    const existing = this.bySession.get(sessionId) ?? []
    const list = existing.length > 0 && existing.every(task =>
      task.status === 'completed' || task.status === 'cancelled'
    ) ? [] : existing
    for (const item of items) {
      list.push({
        id: this.nextId(sessionId),
        subject: item.subject,
        description: item.description ?? '',
        status: 'pending',
        ...(item.files && item.files.length > 0 ? { files: item.files } : {}),
        ...(item.activeForm ? { activeForm: item.activeForm } : {}),
        ...(item.title ? { title: item.title } : {}),
        ...(item.subtitle ? { subtitle: item.subtitle } : {}),
        ...(item.groupId ? { groupId: item.groupId } : {}),
        ...(item.groupTitle ? { groupTitle: item.groupTitle } : {}),
        ...(item.groupSubtitle ? { groupSubtitle: item.groupSubtitle } : {}),
        ...(item.riskLevel ? { riskLevel: item.riskLevel } : {}),
        ...(item.requiresApproval !== undefined ? { requiresApproval: item.requiresApproval } : {}),
        ...(item.approvalStatus ? { approvalStatus: item.approvalStatus } : {}),
        ...(item.acceptanceCriteria && item.acceptanceCriteria.length > 0 ? { acceptanceCriteria: item.acceptanceCriteria } : {}),
        ...(item.verificationCommand ? { verificationCommand: item.verificationCommand } : {}),
        ...(item.contextBundle ? { contextBundle: item.contextBundle } : {}),
      })
    }
    this.bySession.set(sessionId, list)
    this.persist(sessionId)
    this.broadcast(sessionId)
    return this.list(sessionId)
  }

  /**
   * 更新单个 Task 的字段。
   * @returns 更新后的 Task，或 null（未找到）
   */
  update(
    sessionId: string,
    taskId: string,
    patch: Partial<Pick<TaskItem,
      'subject' |
      'description' |
      'status' |
      'files' |
      'activeForm' |
      'groupId' |
      'groupTitle' |
      'groupSubtitle' |
      'riskLevel' |
      'requiresApproval' |
      'approvalStatus' |
      'acceptanceCriteria' |
      'verificationCommand' |
      'contextBundle' |
      'executorRuntime'
    >>
  ): TaskItem | null {
    const list = this.bySession.get(sessionId)
    const task = list?.find(t => t.id === taskId)
    if (!list || !task) return null

    if (patch.subject !== undefined) task.subject = patch.subject
    if (patch.description !== undefined) task.description = patch.description
    if (patch.status !== undefined && patch.status !== task.status) {
      task.status = patch.status
      if (!('executorRuntime' in patch) && task.executorRuntime) {
        task.executorRuntime = {
          ...task.executorRuntime,
          detached: true,
          updatedAt: Date.now(),
        }
      }
    }
    if (patch.files !== undefined) task.files = patch.files
    if (patch.activeForm !== undefined) task.activeForm = patch.activeForm
    if (patch.groupId !== undefined) task.groupId = patch.groupId
    if (patch.groupTitle !== undefined) task.groupTitle = patch.groupTitle
    if (patch.groupSubtitle !== undefined) task.groupSubtitle = patch.groupSubtitle
    if (patch.riskLevel !== undefined) task.riskLevel = patch.riskLevel
    if (patch.requiresApproval !== undefined) task.requiresApproval = patch.requiresApproval
    if (patch.approvalStatus !== undefined) task.approvalStatus = patch.approvalStatus
    if (patch.acceptanceCriteria !== undefined) task.acceptanceCriteria = patch.acceptanceCriteria
    if (patch.verificationCommand !== undefined) task.verificationCommand = patch.verificationCommand
    if (patch.contextBundle !== undefined) task.contextBundle = patch.contextBundle
    if ('executorRuntime' in patch) task.executorRuntime = patch.executorRuntime

    this.persist(sessionId)
    this.broadcast(sessionId)
    return task
  }

  /** 批量设置逻辑状态（兼容非 ExecutionController 调用方）。 */
  setStatuses(sessionId: string, updates: Array<{ id: string; status: TaskStatus }>): void {
    const list = this.bySession.get(sessionId)
    if (!list) return
    let changed = false
    for (const u of updates) {
      const task = list.find(t => t.id === u.id)
      if (task && task.status !== u.status) {
        task.status = u.status
        if (task.executorRuntime) {
          task.executorRuntime = {
            ...task.executorRuntime,
            detached: true,
            updatedAt: Date.now(),
          }
        }
        changed = true
      }
    }
    if (!changed) return
    this.persist(sessionId)
    this.broadcast(sessionId)
  }

  /**
   * 将权威 Executor snapshot 投影到对应 TaskItem。
   * 心跳等不改变可见字段的事件不会触发落盘或 IPC 广播。
   */
  applyExecutionEvent(event: ParallelExecutionEvent): void {
    const execution = event.snapshot
    if (
      execution.sessionId !== event.sessionId ||
      execution.source !== `task:${event.sessionId}`
    ) {
      return
    }

    const list = this.bySession.get(event.sessionId)
    if (!list) return
    const executorsByStep = new Map(execution.executors.map(executor => [executor.stepId, executor]))
    let changed = false

    const next = list.map(task => {
      const executor = executorsByStep.get(task.id)
      if (!executor) return task

      const currentRuntime = task.executorRuntime
      if (
        currentRuntime?.detached &&
        currentRuntime.executionId === execution.executionId
      ) {
        return task
      }
      if (
        currentRuntime &&
        currentRuntime.executionId !== execution.executionId &&
        (
          currentRuntime.executionCreatedAt > execution.createdAt ||
          (
            currentRuntime.executionCreatedAt === execution.createdAt &&
            event.type !== 'created'
          )
        )
      ) {
        return task
      }

      const runtimeFields: Omit<TaskExecutorRuntime, 'updatedAt'> = {
        executionId: execution.executionId,
        executionCreatedAt: execution.createdAt,
        executorId: executor.executorId,
        waveIndex: executor.waveIndex,
        isolation: execution.isolation,
        status: executor.status,
        attemptCount: executor.attemptCount,
        ...(executor.summary ? { summary: executor.summary } : {}),
        ...(executor.error ? { error: executor.error } : {}),
        ...(executor.failureReason ? { failureReason: executor.failureReason } : {}),
        ...(executor.artifactStatus ? { artifactStatus: executor.artifactStatus } : {}),
      }
      const nextStatus = projectLogicalStatus(task.status, execution, executor)
      const runtimeUnchanged = sameExecutorRuntime(currentRuntime, runtimeFields)
      if (runtimeUnchanged && nextStatus === task.status) return task

      changed = true
      return {
        ...task,
        status: nextStatus,
        executorRuntime: runtimeUnchanged
          ? currentRuntime
          : { ...runtimeFields, updatedAt: event.timestamp },
      }
    })

    if (!changed) return
    this.bySession.set(event.sessionId, next)
    this.persist(event.sessionId)
    this.broadcast(event.sessionId)
  }

  /** 校验：某会话至多 1 个 in_progress。返回 true 表示合法。 */
  hasAtMostOneInProgress(sessionId: string): boolean {
    const list = this.bySession.get(sessionId) ?? []
    return list.filter(t => t.status === 'in_progress').length <= 1
  }

  /** 汇总文案，如 "2/5 completed, 1 in progress"。 */
  summary(sessionId: string): string {
    const list = this.bySession.get(sessionId) ?? []
    const total = list.length
    const completed = list.filter(t => t.status === 'completed').length
    const inProgress = list.filter(t => t.status === 'in_progress').length
    const cancelled = list.filter(t => t.status === 'cancelled').length
    const parts = [`${completed}/${total} completed`]
    if (inProgress > 0) parts.push(`${inProgress} in progress`)
    if (cancelled > 0) parts.push(`${cancelled} cancelled`)
    return parts.join(', ')
  }

  /** 清空某会话的 Task（会话删除时调用）。 */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId)
    this.counters.delete(sessionId)
    this.persist(sessionId)
    this.broadcast(sessionId)
  }

  private broadcast(sessionId: string): void {
    const tasks = this.list(sessionId)
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send(IPC_CHANNELS.TASK_UPDATED, { sessionId, tasks })
    })
  }
}
