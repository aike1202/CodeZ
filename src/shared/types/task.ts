/**
 * 轻量 Task（待办）类型定义。
 *
 * Task 是"本次会话内"的执行追踪单元，与重型 Plan 互补：
 * - Plan 回答"该做什么"（规划 + 用户审批 + 跨会话落盘）
 * - Task 回答"做到哪了"（模型自主创建/打勾，仅会话内存，不落盘）
 *
 * Task 可脱离 Plan 独立存在；需要并行时通过 DelegateTasks 委派给多个 Worker。
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

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
