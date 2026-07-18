import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import type {
  TodoApprovalStatus,
  TodoContextBundle,
  TodoItem,
  TodoRiskLevel,
} from '../../shared/types/task'
import type { SessionData } from '../../shared/types/session'
import { getSessionStore } from '../ipc/session.handlers'

export type TodoPatch = Partial<Pick<TodoItem,
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
  'contextBundle'
>> & {
  addBlockedBy?: string[]
  removeBlockedBy?: string[]
}

/**
 * 轻量 Task 的存储（单例）。
 *
 * 内存为主（bySession），每次变更后同步写入 SessionData.tasks 字段，
 * 走 SessionStore.save() 落盘。进程重启 / 会话切换时从磁盘恢复。
 */
export class TodoStore {
  private static instance: TodoStore | null = null

  /** sessionId → 有序 Task 列表 */
  private bySession = new Map<string, TodoItem[]>()
  /** sessionId → 自增计数器（用于生成 t1/t2... 稳定 ID） */
  private counters = new Map<string, number>()
  private revisions = new Map<string, number>()

  static getInstance(): TodoStore {
    if (!this.instance) {
      this.instance = new TodoStore()
    }
    return this.instance
  }

  /** 返回某会话的 Task 列表（副本）。 */
  list(sessionId: string): TodoItem[] {
    return (this.bySession.get(sessionId) ?? []).map(item => ({ ...item }))
  }

  getById(sessionId: string, taskId: string): TodoItem | undefined {
    return this.bySession.get(sessionId)?.find(t => t.id === taskId)
  }

  /** 从磁盘恢复整组 tasks 到内存（AgentRunner 启动时调用）。 */
  restore(sessionId: string, tasks: TodoItem[]): void {
    const items = tasks.map((task) => {
      const { executorRuntime: _legacyExecutorRuntime, ...item } = task as TodoItem & { executorRuntime?: unknown }
      return item
    })
    this.bySession.set(sessionId, items)
    const maxNum = tasks
      .map(t => parseInt(t.id.slice(1), 10))
      .filter(n => !isNaN(n))
      .reduce((max, n) => Math.max(max, n), 0)
    this.counters.set(sessionId, maxNum)
    this.revisions.set(sessionId, 0)
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
      riskLevel?: TodoRiskLevel
      requiresApproval?: boolean
      approvalStatus?: TodoApprovalStatus
      acceptanceCriteria?: string[]
      verificationCommand?: string
      contextBundle?: TodoContextBundle
    }>
  ): TodoItem[] {
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
    this.revisions.set(sessionId, this.revision(sessionId) + 1)
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
    patch: TodoPatch
  ): TodoItem | null {
    try {
      return this.updateBatch(sessionId, undefined, [{ todoId: taskId, ...patch }]).items
        .find(item => item.id === taskId) ?? null
    } catch {
      return null
    }
  }

  updateBatch(
    sessionId: string,
    expectedRevision: number | undefined,
    updates: Array<TodoPatch & { todoId: string }>
  ): { revision: number; items: TodoItem[] } {
    if (updates.length === 0) throw new Error('TodoUpdate requires at least one update.')
    if (expectedRevision !== undefined && expectedRevision !== this.revision(sessionId)) {
      throw new Error(`Todo state changed; latest revision is ${this.revision(sessionId)}.`)
    }
    const ids = new Set(updates.map(update => update.todoId))
    if (ids.size !== updates.length) {
      throw new Error('TodoUpdate cannot update the same item more than once.')
    }

    const current = this.bySession.get(sessionId) ?? []
    const next = current.map(item => ({ ...item, blockedBy: [...(item.blockedBy ?? [])] }))
    for (const update of updates) {
      const item = next.find(candidate => candidate.id === update.todoId)
      if (!item) throw new Error(`Todo '${update.todoId}' not found.`)
      this.applyPatch(item, update)
    }
    this.validateFinalState(next)
    if (JSON.stringify(next) === JSON.stringify(current)) {
      return { revision: this.revision(sessionId), items: this.list(sessionId) }
    }

    this.bySession.set(sessionId, next)
    const revision = this.revision(sessionId) + 1
    this.revisions.set(sessionId, revision)
    this.persist(sessionId)
    this.broadcast(sessionId)
    return { revision, items: this.list(sessionId) }
  }

  revision(sessionId: string): number {
    return this.revisions.get(sessionId) ?? 0
  }

  promptState(sessionId: string): string | undefined {
    const items = this.list(sessionId)
    if (items.length === 0) return undefined
    const active = items.find(item => item.status === 'in_progress')
    const state = {
      summary: {
        total: items.length,
        completed: items.filter(item => item.status === 'completed').length,
        pending: items.filter(item => item.status === 'pending').length,
        cancelled: items.filter(item => item.status === 'cancelled').length,
        omitted: Math.max(items.length - 40, 0)
      },
      active: active ? {
        ...active,
        subject: active.subject.slice(0, 200),
        description: active.description.slice(0, 4000),
        blockedBy: active.blockedBy?.slice(0, 16),
        files: active.files?.slice(0, 16),
        acceptanceCriteria: active.acceptanceCriteria?.slice(0, 16)
      } : null,
      items: items.slice(0, 40).map(item => ({
        id: item.id,
        subject: item.subject.slice(0, 200),
        status: item.status,
        blockedBy: item.blockedBy?.slice(0, 16) ?? [],
        requiresApproval: item.requiresApproval === true,
        approvalStatus: item.approvalStatus ?? (item.requiresApproval ? 'pending' : 'not_required')
      }))
    }
    const encoded = JSON.stringify(state).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
    return `<todo_state revision="${this.revision(sessionId)}">\n${encoded}\n</todo_state>`
  }

  private applyPatch(item: TodoItem, patch: TodoPatch): void {
    if (patch.subject !== undefined) item.subject = patch.subject
    if (patch.description !== undefined) item.description = patch.description
    if (patch.status !== undefined) item.status = patch.status
    if (patch.files !== undefined) item.files = patch.files
    if (patch.activeForm !== undefined) item.activeForm = patch.activeForm
    if (patch.groupId !== undefined) item.groupId = patch.groupId
    if (patch.groupTitle !== undefined) item.groupTitle = patch.groupTitle
    if (patch.groupSubtitle !== undefined) item.groupSubtitle = patch.groupSubtitle
    if (patch.riskLevel !== undefined) item.riskLevel = patch.riskLevel
    if (patch.requiresApproval !== undefined) item.requiresApproval = patch.requiresApproval
    if (patch.approvalStatus !== undefined) item.approvalStatus = patch.approvalStatus
    if (patch.acceptanceCriteria !== undefined) item.acceptanceCriteria = patch.acceptanceCriteria
    if (patch.verificationCommand !== undefined) item.verificationCommand = patch.verificationCommand
    if (patch.contextBundle !== undefined) item.contextBundle = patch.contextBundle
    const removed = new Set(patch.removeBlockedBy ?? [])
    const blockedBy = (item.blockedBy ?? []).filter(id => !removed.has(id))
    for (const id of patch.addBlockedBy ?? []) {
      if (!blockedBy.includes(id)) blockedBy.push(id)
    }
    item.blockedBy = blockedBy.length > 0 ? blockedBy : undefined
  }

  private validateFinalState(items: TodoItem[]): void {
    if (items.filter(item => item.status === 'in_progress').length > 1) {
      throw new Error('Another Todo item is already in_progress.')
    }
    const byId = new Map(items.map(item => [item.id, item]))
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (item: TodoItem): void => {
      if (visiting.has(item.id)) throw new Error('Todo dependencies cannot contain a cycle.')
      if (visited.has(item.id)) return
      visiting.add(item.id)
      for (const dependencyId of item.blockedBy ?? []) {
        if (dependencyId === item.id) throw new Error('A Todo item cannot depend on itself.')
        const dependency = byId.get(dependencyId)
        if (!dependency) throw new Error(`Todo '${item.id}' depends on missing Todo '${dependencyId}'.`)
        visit(dependency)
      }
      visiting.delete(item.id)
      visited.add(item.id)
    }
    items.forEach(visit)
    for (const item of items) {
      if (item.status !== 'in_progress' && item.status !== 'completed') continue
      if (item.requiresApproval && item.approvalStatus !== 'approved') {
        throw new Error(`Todo '${item.id}' requires approval before it can start or complete.`)
      }
      const unfinished = (item.blockedBy ?? []).filter(id => byId.get(id)?.status !== 'completed')
      if (unfinished.length > 0) {
        throw new Error(`Todo '${item.id}' is blocked by: ${unfinished.join(', ')}.`)
      }
    }
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
    this.revisions.delete(sessionId)
    this.persist(sessionId)
    this.broadcast(sessionId)
  }

  private broadcast(sessionId: string): void {
    const tasks = this.list(sessionId)
    const windows = BrowserWindow?.getAllWindows?.() ?? []
    windows.forEach(win => {
      win.webContents.send(IPC_CHANNELS.TASK_UPDATED, { sessionId, tasks })
    })
  }
}

export { TodoStore as TaskStore }
