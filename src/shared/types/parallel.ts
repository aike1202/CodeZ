/**
 * 并行 Plan 执行相关类型。
 *
 * ExecutionPlanner 输出分波方案，编排协调器按波执行 Worker，
 * 聚合结果为 ParallelExecutionReport 交回主 Agent。
 */

/** 质量摘要（与 SubAgentManager.SubAgentQualitySummary 结构一致，此处独立声明避免 shared→main 依赖）。 */
export interface ParallelQualitySummary {
  coverage: number
  confidence: string
  unresolvedCount: number
  filesExaminedCount: number
  warning: string | null
}

/** ExecutionPlanner 的结构化输出（解析后）。 */
export interface ExecutionGroupingResult {
  /** 波次数组，按执行顺序排列 */
  waves: ExecutionWave[]
  /** 隔离建议 */
  isolation: 'shared' | 'worktree'
  /** 分组理由，一句话 */
  rationale: string
}

export interface ExecutionWave {
  /** 波次序号，从 0 递增 */
  index: number
  /** 本波并行执行的步骤 ID（引用 PlanStep.id 或 TaskItem.id） */
  stepIds: string[]
}

/**
 * 通用执行单元 —— orchestrator 不再直接依赖 Plan/PlanStep。
 * PlanStep 与 TaskItem 都可映射为 ExecUnit（两者字段是其超集）。
 */
export interface ExecUnit {
  /** 单元 ID（波次的 stepIds 引用此 ID） */
  id: string
  /** 简短标题 */
  title: string
  /** 详细描述 */
  description: string
  /** 涉及文件路径列表（冲突校验 + shared 档写权限范围） */
  files?: string[]
  /** 研究与 Plan 阶段传递给 Executor 的上下文胶囊。 */
  contextBundle?: import('./task').TaskContextBundle
  acceptanceCriteria?: string[]
  verificationCommand?: string
}

export type ParallelExecStatus = 'completed' | 'halted'

/** 编排协调器聚合后返回主 Agent 的报告。 */
export interface ParallelExecutionReport {
  /** 执行来源标识：Plan 用 `plan:<slug>`，Task 用 `task:<sessionId>`。 */
  source: string
  /** @deprecated 用 source 代替；Plan 路径保留以兼容前端 */
  planSlug?: string
  status: ParallelExecStatus
  waves: WaveReport[]
  /** halted 时：哪一波、哪些步骤失败 */
  haltedAt?: { waveIndex: number; failedStepIds: string[] }
}

export interface WaveReport {
  waveIndex: number
  results: StepResult[]
}

export type StepResultStatus = 'completed' | 'failed'

export interface StepResult {
  stepId: string
  status: StepResultStatus
  /** Worker 的 submit_result 摘要 */
  summary: string
  filesModified: string[]
  qualitySummary?: ParallelQualitySummary
  error?: string
  /** worktree 档合并失败时保留的 worktree 路径，供排查 */
  worktreePath?: string
}

/** 前端波次进度事件的 payload。 */
export interface ParallelWaveUpdatePayload {
  waveIndex: number
  status: 'in_progress' | 'completed' | 'failed'
  stepResults: StepResult[]
}
