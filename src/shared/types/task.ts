/**
 * 轻量 Task（待办）类型定义。
 *
 * Task 是会话级执行追踪单元，会随 SessionData.tasks 落盘并在会话恢复时加载。
 * 统一 Task 系统承担：
 * - 简单任务：直接执行，不创建 Task
 * - 多步任务：创建 TaskGroup 并持续更新状态
 * - 高风险任务：TaskGroup 标记 requiresApproval，先审批再执行
 * - 独立任务：通过 DelegateTasks 并行委派
 *
 * Legacy Plan 仍可兼容读取，但默认执行路径应优先使用 Task。
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type TaskRiskLevel = 'low' | 'medium' | 'high'
export type TaskApprovalStatus = 'not_required' | 'pending' | 'approved' | 'changes_requested' | 'rejected'

export interface TaskContextBundle {
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

export interface TaskItem {
  /** 稳定短 ID（t1 / t2 ...）；委派 Worker 时按此引用 */
  id: string
  /** 祈使句标题，如 "提取 useAuth hook" */
  subject: string
  /** 任务清单的整体标题（可选，如 "TodoList 应用开发任务"） */
  title?: string
  /** 任务清单的整体副标题/摘要（可选，如 "基于 React + Electron 的待办事项桌面应用"） */
  subtitle?: string
  /** 详细描述：目标 + 验收标准 */
  description: string
  status: TaskStatus
  /** TaskGroup 标识；同一组任务共享审批与目标上下文 */
  groupId?: string
  /** TaskGroup 展示标题；前端优先使用该字段作为清单头 */
  groupTitle?: string
  /** TaskGroup 副标题/摘要 */
  groupSubtitle?: string
  /** 风险等级：high 通常需要用户审批后再执行 */
  riskLevel?: TaskRiskLevel
  /** 是否要求用户审批该 TaskGroup */
  requiresApproval?: boolean
  /** 审批状态；requiresApproval=false 时为 not_required */
  approvalStatus?: TaskApprovalStatus
  /** 结构化验收标准，避免只把验收条件塞进 description */
  acceptanceCriteria?: string[]
  /** 推荐验证命令，完成任务前优先运行 */
  verificationCommand?: string
  /** 从研究与 Plan 阶段传递给执行智能体的任务专属上下文。 */
  contextBundle?: TaskContextBundle
  /** 涉及文件路径列表（相对 workspaceRoot）；委派 Worker 时用于冲突校验与共享工作区写权限范围 */
  files?: string[]
  /** 进行时文案，给进度条显示，如 "提取 useAuth hook 中" */
  activeForm?: string
}

/** IPC TASK_UPDATED 事件 payload：某会话的全量 Task 清单。 */
export interface TaskUpdatePayload {
  sessionId: string
  tasks: TaskItem[]
}
