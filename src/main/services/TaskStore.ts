import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import type { TaskApprovalStatus, TaskItem, TaskRiskLevel, TaskStatus } from '../../shared/types/task'
import type { SessionData } from '../../shared/types/session'
import { getSessionStore } from '../ipc/session.handlers'

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

  static getInstance(): TaskStore {
    if (!this.instance) {
      this.instance = new TaskStore()
    }
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
      'verificationCommand'
    >>
  ): TaskItem | null {
    const list = this.bySession.get(sessionId)
    const task = list?.find(t => t.id === taskId)
    if (!list || !task) return null

    if (patch.subject !== undefined) task.subject = patch.subject
    if (patch.description !== undefined) task.description = patch.description
    if (patch.status !== undefined) task.status = patch.status
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

    this.persist(sessionId)
    this.broadcast(sessionId)
    return task
  }

  /** 批量设置状态（供 DelegateTasks 回写 Worker 结果）。 */
  setStatuses(sessionId: string, updates: Array<{ id: string; status: TaskStatus }>): void {
    const list = this.bySession.get(sessionId)
    if (!list) return
    for (const u of updates) {
      const task = list.find(t => t.id === u.id)
      if (task) task.status = u.status
    }
    this.persist(sessionId)
    this.broadcast(sessionId)
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
