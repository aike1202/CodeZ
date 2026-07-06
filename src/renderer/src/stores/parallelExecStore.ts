import { create } from 'zustand'

/**
 * 并行 Plan 执行的实时状态（临时，不持久化）。
 *
 * 主进程是唯一数据源；此 store 只监听 3 个 PARALLEL_* 广播事件并渲染。
 * 单向数据流：state 向下流到 ParallelWaveGroup，无事件向上（触发由 Plan 卡片走 chat）。
 */

export interface ParallelWaveDef {
  index: number
  stepIds: string[]
}

export type ParallelWaveStatus = 'waiting' | 'in_progress' | 'completed' | 'failed'

export interface ParallelStepResult {
  stepId: string
  status: 'completed' | 'failed'
  summary: string
  filesModified: string[]
  error?: string
  worktreePath?: string
}

export interface ParallelWaveState {
  index: number
  stepIds: string[]
  status: ParallelWaveStatus
  stepResults: ParallelStepResult[]
}

export interface ParallelExecState {
  active: boolean
  planSlug: string | null
  isolation: 'shared' | 'worktree' | null
  rationale: string
  waves: ParallelWaveState[]
  /** 'running' | 'completed' | 'halted' | null */
  overallStatus: 'running' | 'completed' | 'halted' | null

  handleStarted: (payload: { planSlug: string; waves: ParallelWaveDef[]; isolation: string; rationale: string }) => void
  handleWaveUpdate: (payload: { waveIndex: number; status: string; stepResults: ParallelStepResult[] }) => void
  handleDone: (payload: { report: { status: 'completed' | 'halted'; haltedAt?: { waveIndex: number } } }) => void
  reset: () => void
}

const initial = {
  active: false,
  planSlug: null as string | null,
  isolation: null as 'shared' | 'worktree' | null,
  rationale: '',
  waves: [] as ParallelWaveState[],
  overallStatus: null as 'running' | 'completed' | 'halted' | null,
}

export const useParallelExecStore = create<ParallelExecState>((set) => ({
  ...initial,

  handleStarted: (payload) =>
    set({
      active: true,
      planSlug: payload.planSlug,
      isolation: payload.isolation === 'worktree' ? 'worktree' : 'shared',
      rationale: payload.rationale,
      overallStatus: 'running',
      waves: payload.waves
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((w) => ({
          index: w.index,
          stepIds: w.stepIds,
          status: 'waiting' as ParallelWaveStatus,
          stepResults: [],
        })),
    }),

  handleWaveUpdate: (payload) =>
    set((s) => ({
      waves: s.waves.map((w) =>
        w.index === payload.waveIndex
          ? {
              ...w,
              status: (payload.status as ParallelWaveStatus) || w.status,
              stepResults: payload.stepResults?.length ? payload.stepResults : w.stepResults,
            }
          : w
      ),
    })),

  handleDone: (payload) =>
    set((s) => ({
      overallStatus: payload.report.status === 'halted' ? 'halted' : 'completed',
      // halted 时：把后续未跑的波标记为已取消（用 waiting 视觉降级由组件处理）
      waves: s.waves,
    })),

  reset: () => set({ ...initial }),
}))
