/**
 * 会话级 Todo 类型定义。
 *
 * `SessionData.tasks` 仅保留为旧会话的持久化字段名。Todo 描述工作状态，
 * 不拥有 Agent 或 Executor 生命周期。
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type TodoRiskLevel = 'low' | 'medium' | 'high'
export type TodoApprovalStatus = 'not_required' | 'pending' | 'approved' | 'changes_requested' | 'rejected'

export interface TodoContextBundle {
  /** 研究阶段已经确认、执行阶段可直接使用的事实。 */
  knownFacts?: string[]
  /** 主 Agent 在 Plan 阶段确定的实现决策。 */
  decisions?: string[]
  /** 执行边界、兼容性要求等约束。 */
  constraints?: string[]
  /** 已调查且确认无需重复探索的方向。 */
  excludedDirections?: string[]
  /** 带行号和可选 SHA 的源码证据引用。 */
  sourceReferences?: string[]
}

export interface TodoItem {
  /** 稳定短 ID（t1 / t2 ...） */
  id: string
  /** 祈使句标题，如 "提取 useAuth hook" */
  subject: string
  /** 任务清单的整体标题（可选，如 "TodoList 应用开发任务"） */
  title?: string
  /** 任务清单的整体副标题/摘要（可选，如 "基于 React + Electron 的待办事项桌面应用"） */
  subtitle?: string
  /** 详细描述：目标 + 验收标准 */
  description: string
  status: TodoStatus
  /** 当前 Todo 必须等待完成的其他 Todo ID；反向 blocks 由此派生。 */
  blockedBy?: string[]
  /** TaskGroup 标识；同一组任务共享审批与目标上下文 */
  groupId?: string
  /** TaskGroup 展示标题；前端优先使用该字段作为清单头 */
  groupTitle?: string
  /** TaskGroup 副标题/摘要 */
  groupSubtitle?: string
  /** 风险等级：high 通常需要用户审批后再执行 */
  riskLevel?: TodoRiskLevel
  /** 是否要求用户审批该 TaskGroup */
  requiresApproval?: boolean
  /** 审批状态；requiresApproval=false 时为 not_required */
  approvalStatus?: TodoApprovalStatus
  /** 结构化验收标准，避免只把验收条件塞进 description */
  acceptanceCriteria?: string[]
  /** 推荐验证命令，完成任务前优先运行 */
  verificationCommand?: string
  /** 从研究与 Plan 阶段传递给执行智能体的任务专属上下文。 */
  contextBundle?: TodoContextBundle
  /** 涉及文件路径列表（相对 workspaceRoot） */
  files?: string[]
  /** 进行时文案，给进度条显示，如 "提取 useAuth hook 中" */
  activeForm?: string
}

/** IPC TODO_UPDATED 事件 payload：某会话的全量 Todo 清单。 */
export interface TodoUpdatePayload {
  sessionId: string
  items: TodoItem[]
}

// Persisted Electron sessions and older renderer code still use these type names.
export type TaskStatus = TodoStatus
export type TaskRiskLevel = TodoRiskLevel
export type TaskApprovalStatus = TodoApprovalStatus
export type TaskContextBundle = TodoContextBundle
export type TaskItem = TodoItem
export type TaskUpdatePayload = { sessionId: string; tasks: TodoItem[] }
