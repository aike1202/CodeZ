import { create } from 'zustand'
import type {
  ExecutorRuntimeStatus,
  ParallelExecutionEvent
} from '../../../shared/types/parallel'

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
  status: 'succeeded' | 'completed' | 'failed'
  summary: string
  filesModified: string[]
  error?: string
  worktreePath?: string
  artifactStatus?: import('../../../shared/types/parallel').ArtifactRuntimeStatus
}

export interface ParallelWaveState {
  index: number
  stepIds: string[]
  status: ParallelWaveStatus
  stepResults: ParallelStepResult[]
  stepStatuses?: Record<string, ExecutorRuntimeStatus>
}

export interface ParallelExecState {
  active: boolean
  executionId: string | null
  sessionId: string | null
  lastSequence: number
  planSlug: string | null
  isolation: 'shared' | 'worktree' | null
  rationale: string
  waves: ParallelWaveState[]
  /** 'running' | 'completed' | 'halted' | null */
  overallStatus: 'running' | 'completed' | 'halted' | 'stopped' | 'decision_required' | null

  handleStarted: (payload: { executionId?: string; sessionId?: string; planSlug?: string; waves: ParallelWaveDef[]; isolation: string; rationale: string }) => void
  handleWaveUpdate: (payload: { executionId?: string; sessionId?: string; waveIndex: number; status: string; stepResults: ParallelStepResult[] }) => void
  handleDone: (payload: { executionId?: string; sessionId?: string; report: { status: 'completed' | 'halted' | 'stopped'; haltedAt?: { waveIndex: number } } }) => void
  handleExecutionEvent: (event: ParallelExecutionEvent) => void
  reset: () => void
}

const initial = {
  active: false,
  executionId: null as string | null,
  sessionId: null as string | null,
  lastSequence: 0,
  planSlug: null as string | null,
  isolation: null as 'shared' | 'worktree' | null,
  rationale: '',
  waves: [] as ParallelWaveState[],
  overallStatus: null as 'running' | 'completed' | 'halted' | 'stopped' | 'decision_required' | null,
}

export const useParallelExecStore = create<ParallelExecState>((set) => ({
  ...initial,

  handleStarted: (payload) =>
    set((s) => {
      if (payload.executionId && s.executionId === payload.executionId && s.lastSequence > 0) return s
      return {
      active: true,
      executionId: payload.executionId || null,
      sessionId: payload.sessionId || null,
      lastSequence: 0,
      planSlug: payload.planSlug || null,
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
          stepStatuses: Object.fromEntries(w.stepIds.map((stepId) => [stepId, 'queued'])),
        })),
      }
    }),

  handleWaveUpdate: (payload) =>
    set((s) => {
      if (payload.executionId && s.executionId && payload.executionId !== s.executionId) return s
      if (payload.sessionId && s.sessionId && payload.sessionId !== s.sessionId) return s
      if (payload.executionId === s.executionId && s.lastSequence > 0) return s
      return {
      waves: s.waves.map((w) =>
        w.index === payload.waveIndex
          ? {
              ...w,
              status: (payload.status as ParallelWaveStatus) || w.status,
              stepResults: payload.stepResults?.length ? payload.stepResults : w.stepResults,
            }
          : w
      ),
      }
    }),

  handleDone: (payload) =>
    set((s) => {
      if (payload.executionId && s.executionId && payload.executionId !== s.executionId) return s
      if (payload.sessionId && s.sessionId && payload.sessionId !== s.sessionId) return s
      if (payload.executionId === s.executionId && s.lastSequence > 0) return s
      return {
      overallStatus: payload.report.status,
      // halted 时：把后续未跑的波标记为已取消（用 waiting 视觉降级由组件处理）
      waves: s.waves,
      }
    }),

  handleExecutionEvent: (event) =>
    set((s) => {
      if (s.executionId === event.executionId && event.sequence <= s.lastSequence) return s
      const snapshot = event.snapshot
      const waves: ParallelWaveState[] = snapshot.waves.map((wave) => {
        const executorStates = snapshot.executors.filter((executor) => executor.waveIndex === wave.index)
        const stepStatuses = Object.fromEntries(executorStates.map((executor) => [executor.stepId, executor.status]))
        const stepResults: ParallelStepResult[] = executorStates
          .filter((executor) => ['succeeded', 'completed', 'failed', 'interrupted', 'stopped', 'lost'].includes(executor.status))
          .map((executor) => ({
            stepId: executor.stepId,
            status: executor.status === 'completed'
              ? 'completed'
              : executor.status === 'succeeded'
                ? 'succeeded'
                : 'failed',
            summary: executor.summary || '',
            filesModified: executor.filesModified,
            error: executor.error,
            worktreePath: executor.worktreePath
          }))
        const status: ParallelWaveStatus = executorStates.some((executor) => executor.status === 'running')
          ? 'in_progress'
          : executorStates.length > 0 && executorStates.every((executor) => executor.status === 'completed')
            ? 'completed'
            : executorStates.some((executor) => ['failed', 'interrupted', 'stopped', 'lost'].includes(executor.status))
              ? 'failed'
              : 'waiting'
        return { index: wave.index, stepIds: wave.stepIds, status, stepResults, stepStatuses }
      })
      const overallStatus: ParallelExecState['overallStatus'] = snapshot.status === 'planned' || snapshot.status === 'running'
        ? 'running'
        : snapshot.status === 'decision_required'
          ? 'decision_required'
          : snapshot.status === 'completed'
            ? 'completed'
            : snapshot.status === 'stopped' || snapshot.status === 'cancelled'
              ? 'stopped'
              : 'halted'
      return {
        active: true,
        executionId: snapshot.executionId,
        sessionId: snapshot.sessionId,
        lastSequence: event.sequence,
        planSlug: snapshot.source.startsWith('plan:') ? snapshot.source.slice(5) : null,
        isolation: snapshot.isolation,
        rationale: snapshot.rationale,
        waves,
        overallStatus
      }
    }),

  reset: () => set({ ...initial }),
}))
