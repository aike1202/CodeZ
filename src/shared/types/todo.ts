/**
 * 会话级 Todo 类型定义。
 *
 * Todo 描述工作状态，权威状态由 Rust TodoStore 持久化。
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type TodoRiskLevel = 'low' | 'medium' | 'high'
export type TodoApprovalStatus = 'not_required' | 'pending' | 'approved' | 'changes_requested' | 'rejected'
export type TodoVerificationOutcome = 'passed' | 'failed'

export interface TodoVerificationEvidence {
  outcome: TodoVerificationOutcome
  summary: string
  command?: string
  exitCode?: number
  toolCallId?: string
}

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
  /** 任务清单的整体副标题/摘要（可选） */
  subtitle?: string
  /** 详细描述：目标 + 验收标准 */
  description: string
  status: TodoStatus
  /** 当前 Todo 必须等待完成的其他 Todo ID；反向 blocks 由此派生。 */
  blockedBy?: string[]
  /** Todo group 标识；同一组 Todo 共享审批与目标上下文 */
  groupId?: string
  /** Todo group 展示标题；前端优先使用该字段作为清单头 */
  groupTitle?: string
  /** Todo group 副标题/摘要 */
  groupSubtitle?: string
  /** 风险等级：high 通常需要用户审批后再执行 */
  riskLevel?: TodoRiskLevel
  /** 是否要求用户审批该 Todo group */
  requiresApproval?: boolean
  /** 审批状态；requiresApproval=false 时为 not_required */
  approvalStatus?: TodoApprovalStatus
  /** 结构化验收标准，避免只把验收条件塞进 description */
  acceptanceCriteria?: string[]
  /** 推荐验证命令，完成任务前优先运行 */
  verificationCommand?: string
  /** 支撑完成状态的结构化验证结果。 */
  verificationEvidence?: TodoVerificationEvidence
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
