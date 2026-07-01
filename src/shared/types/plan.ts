/**
 * Plan 实体类型定义。
 *
 * Plan 是跨会话持久化的任务计划，包含结构化步骤（P0/P1/P2...）。
 * 每个 Plan 有状态机生命周期，同一项目任一时刻最多 1 个 executing Plan。
 */

export type PlanStatus =
  | 'drafting'        // AI 正在生成计划
  | 'pending_review'  // AI 已提交，等用户审批
  | 'executing'       // 用户批准，执行中
  | 'revising'        // 用户要求调整，AI 修改中
  | 'suspended'       // 暂挂（用户开新 Plan / 关闭 Plan 模式未完成）
  | 'completed'       // 所有步骤完成，用户确认
  | 'abandoned'       // 用户放弃

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface PlanStep {
  /** 步骤 ID，如 'p0', 'p1' */
  id: string
  /** 简短标题 */
  title: string
  /** 50-150 字：目标 + 涉及文件 + 验收标准 */
  description: string
  status: PlanStepStatus
  /** 涉及的文件路径列表 */
  files?: string[]
}

export interface Plan {
  /** uuid */
  id: string
  /** kebab-case 英文，用于 /命令调用 */
  slug: string
  /** 中文可读标题 */
  title: string
  /** 整体目标描述 */
  description: string
  /** workspace hash（项目隔离） */
  projectId: string
  /** 计划步骤 */
  steps: PlanStep[]
  /** 当前状态 */
  status: PlanStatus
  createdAt: string
  updatedAt: string
  /** 暂挂原因（status=suspended 时） */
  suspendedReason?: string
}
