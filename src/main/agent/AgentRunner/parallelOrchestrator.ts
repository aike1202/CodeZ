import { execFileSync } from 'child_process'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../shared/ipc/channels'
import { WorktreeService } from '../../services/WorktreeService'
import { SubAgentManager } from '../SubAgentManager'
import type { AgentRunnerCallbacks } from './types'
import type {
  ExecUnit,
  ExecutionGroupingResult,
  ExecutionWave,
  ParallelExecutionReport,
  StepResult,
  WaveReport,
} from '../../../shared/types/parallel'

// ─── 配置 ──────────────────────────────────────────────────

export interface ParallelOrchestratorConfig {
  workspaceRoot: string
  sessionId: string
  /** 父工具调用 ID — Worker 的 parentToolCallId 设置为这个值，前端据此把 SubAgentCard 关联到 DelegateTasks */
  parentToolCallId?: string
  apiConfig: {
    baseUrl: string
    apiKey: string
    apiFormat: string
    model: string
    thinking?: boolean
  }
}

/**
 * 执行来源钩子 —— 让 orchestrator 与具体数据源（Plan / Task）解耦。
 *
 * orchestrator 只认 ExecUnit + onStatusChange 回调；由调用方（Plan 或 Task 适配器）
 * 负责把状态写回各自的存储（PlanStore 落盘 / TaskStore 内存）。
 */
export interface ExecutionHooks {
  /** 来源标识：`plan:<slug>` 或 `task:<sessionId>` */
  source: string
  /** 前端事件里展示的来源标签（planSlug 兼容字段），可选 */
  planSlug?: string
  /** 某单元状态变更时回调（调用方据此写回 Plan/Task 存储） */
  onStatusChange: (unitId: string, status: 'in_progress' | 'completed' | 'pending') => Promise<void> | void
}

/** 并发上限：min(6, cpuCount - 1)，避免 API 限流 + 本地 CPU 打满。 */
export function computeConcurrencyLimit(cpuCount: number): number {
  return Math.max(1, Math.min(6, cpuCount - 1))
}

// ─── 纯逻辑：解析 & 冲突校验（可单测） ──────────────────────

/**
 * 解析 ExecutionPlanner 的 waves 输出（string[]，每项 JSON 字符串）为结构化波次。
 * 无效条目跳过；结果按 index 升序排列。
 */
export function parseWaves(rawWaves: string[]): ExecutionWave[] {
  const waves: ExecutionWave[] = []
  for (const raw of rawWaves) {
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (
      parsed &&
      typeof parsed.index === 'number' &&
      Array.isArray(parsed.stepIds) &&
      parsed.stepIds.every((s: unknown) => typeof s === 'string')
    ) {
      waves.push({ index: parsed.index, stepIds: parsed.stepIds })
    }
  }
  return waves.sort((a, b) => a.index - b.index)
}

/**
 * 校验一波内 units 的 files 是否两两不相交。
 * @returns 冲突对列表（空数组 = 无冲突）
 */
export function findWaveFileConflicts(
  wave: ExecutionWave,
  unitsById: Map<string, ExecUnit>
): Array<{ a: string; b: string; files: string[] }> {
  const conflicts: Array<{ a: string; b: string; files: string[] }> = []
  const ids = wave.stepIds
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const filesA = new Set(unitsById.get(ids[i])?.files ?? [])
      const filesB = unitsById.get(ids[j])?.files ?? []
      const shared = filesB.filter(f => filesA.has(f))
      if (shared.length > 0) {
        conflicts.push({ a: ids[i], b: ids[j], files: shared })
      }
    }
  }
  return conflicts
}

/**
 * 全量冲突校验。
 * @returns 校验错误信息（null = 通过）；shared 档有冲突 → 返回错误；worktree 档 → 返回 null（仅记 warning）
 */
export function validateGrouping(
  waves: ExecutionWave[],
  unitsById: Map<string, ExecUnit>,
  isolation: 'shared' | 'worktree'
): { error: string | null; warnings: string[] } {
  const warnings: string[] = []
  for (const wave of waves) {
    const conflicts = findWaveFileConflicts(wave, unitsById)
    for (const c of conflicts) {
      const msg = `Wave ${wave.index}: units ${c.a} and ${c.b} both touch [${c.files.join(', ')}]`
      if (isolation === 'shared') {
        return {
          error: `File conflict in shared isolation mode — ${msg}. Re-group these units into separate waves or use worktree isolation.`,
          warnings,
        }
      }
      warnings.push(`${msg} — merge may require conflict resolution.`)
    }
  }
  return { error: null, warnings }
}

// ─── SubAgent 结构化输出解析 ────────────────────────────────

interface WorkerOutput {
  status: 'completed' | 'failed'
  summary: string
  filesModified: string[]
  blockers?: string[]
}

function parseWorkerOutput(structured: Record<string, any> | undefined): WorkerOutput {
  if (!structured) {
    return { status: 'failed', summary: 'Worker produced no structured output.', filesModified: [] }
  }
  const status = structured.status === 'completed' ? 'completed' : 'failed'
  return {
    status,
    summary: typeof structured.summary === 'string' ? structured.summary : '',
    filesModified: Array.isArray(structured.filesModified) ? structured.filesModified : [],
    blockers: Array.isArray(structured.blockers) ? structured.blockers : undefined,
  }
}

export function normalizeWorkerResult(result: {
  structuredOutput?: Record<string, any>
  output?: string
  [key: string]: any
}): WorkerOutput {
  if (result.structuredOutput) {
    return parseWorkerOutput(result.structuredOutput)
  }

  const text = typeof result.output === 'string' ? result.output.trim() : ''
  if (text) {
    return {
      status: 'completed',
      summary: text,
      filesModified: [],
      blockers: undefined,
    }
  }

  return {
    status: 'failed',
    summary: 'Worker produced no structured output.',
    filesModified: [],
    blockers: undefined,
  }
}

// ─── worktree 合并 ──────────────────────────────────────────

function gitInWorktree(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, timeout: 30_000, stdio: 'pipe' })
}

function hasStagedChanges(cwd: string): boolean {
  try {
    gitInWorktree(cwd, ['diff', '--cached', '--quiet'])
    return false
  } catch (err: any) {
    if (err?.status === 1) {
      return true
    }
    throw err
  }
}

function formatGitError(err: any): string {
  const stderr = err?.stderr?.toString?.().trim()
  const stdout = err?.stdout?.toString?.().trim()
  return stderr || stdout || err?.message || String(err)
}

/**
 * 波末合并一个成功 step 的 worktree 回主工作区。
 * @returns null 成功；否则返回错误信息（合并冲突等）
 */
export function mergeWorktree(
  workspaceRoot: string,
  wtName: string,
  wtPath: string,
  branch: string
): string | null {
  try {
    // worktree 内提交改动
    gitInWorktree(wtPath, ['add', '-A'])
    if (hasStagedChanges(wtPath)) {
      try {
        gitInWorktree(wtPath, ['commit', '-m', `codez: worktree ${wtName}`])
      } catch (err: any) {
        return `commit failed: ${formatGitError(err)}`
      }
    }
    // 主区合并该分支
    gitInWorktree(workspaceRoot, ['merge', '--no-edit', branch])
    return null
  } catch (err: any) {
    // 合并冲突 → abort 保持主区干净
    try {
      gitInWorktree(workspaceRoot, ['merge', '--abort'])
    } catch {
      // ignore
    }
    return err?.message || 'worktree merge failed'
  }
}

// ─── 事件广播 ──────────────────────────────────────────────

function broadcast(channel: string, payload: any): void {
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send(channel, payload)
  })
}

// ─── 主编排函数 ────────────────────────────────────────────

/** 用 source 生成文件系统安全的 worktree 名前缀。 */
function safeName(source: string, unitId: string): string {
  const cleaned = source.replace(/[^a-zA-Z0-9_-]/g, '-')
  return `${cleaned}-${unitId}`
}

/**
 * 并行执行一组 ExecUnit：组内并行、组间串行、失败即停。
 *
 * orchestrator 不依赖 Plan/Task —— 数据源通过 units 传入，状态回写通过 hooks.onStatusChange。
 *
 * @param units 待执行单元（PlanStep / TaskItem 映射而来）
 * @param completedUnitIds 已完成的单元 ID（halted 后重跑时自动跳过）
 * @param grouping ExecutionPlanner / 模型给出的分波方案
 * @param isolation 最终隔离档
 * @param hooks 来源标识 + 状态回写回调
 * @param config 运行配置
 * @param callbacks 用于把 Worker 事件路由到前端卡片
 */
export async function orchestrateParallelExecution(
  units: ExecUnit[],
  completedUnitIds: Set<string>,
  grouping: ExecutionGroupingResult,
  isolation: 'shared' | 'worktree',
  hooks: ExecutionHooks,
  config: ParallelOrchestratorConfig,
  callbacks: AgentRunnerCallbacks
): Promise<ParallelExecutionReport> {
  const unitsById = new Map(units.map(u => [u.id, u]))
  const waves = grouping.waves

  // 1. 冲突校验（兜底守卫）
  const { error: validationError } = validateGrouping(waves, unitsById, isolation)
  if (validationError) {
    throw new Error(validationError)
  }

  broadcast(IPC_CHANNELS.PARALLEL_EXEC_STARTED, {
    source: hooks.source,
    planSlug: hooks.planSlug,
    waves,
    isolation,
    rationale: grouping.rationale,
  })

  const concurrencyLimit = computeConcurrencyLimit(require('os').cpus().length)
  const waveReports: WaveReport[] = []
  let haltedAt: ParallelExecutionReport['haltedAt'] | undefined

  // 2. 按 wave 顺序循环（组间串行）
  for (const wave of waves) {
    const stepIds = wave.stepIds.filter(id => unitsById.has(id) && !completedUnitIds.has(id))
    if (stepIds.length === 0) continue

    // 标记本波 units 为 in_progress
    for (const id of stepIds) {
      await hooks.onStatusChange(id, 'in_progress')
    }
    broadcast(IPC_CHANNELS.PARALLEL_WAVE_UPDATE, {
      waveIndex: wave.index,
      status: 'in_progress',
      stepResults: [],
    })

    // worktree 档：为每个 unit 建 worktree
    const worktrees = new Map<string, { path: string; branch: string; name: string }>()
    if (isolation === 'worktree') {
      for (const id of stepIds) {
        const name = safeName(hooks.source, id)
        const info = WorktreeService.create(config.workspaceRoot, name)
        worktrees.set(id, { path: info.path, branch: info.branch, name })
      }
    }

    // 组内并行 + 并发闸
    const results = await runWithConcurrencyLimit(
      stepIds.map(id => () => spawnWorker(id, unitsById.get(id)!, isolation, worktrees.get(id), config, callbacks)),
      concurrencyLimit
    )

    // worktree 档：波末统一合并成功 unit 回主区
    if (isolation === 'worktree') {
      for (const r of results) {
        const wt = worktrees.get(r.stepId)
        if (!wt) continue
        if (r.status === 'completed') {
          const mergeErr = mergeWorktree(config.workspaceRoot, wt.name, wt.path, wt.branch)
          if (mergeErr) {
            // 合并失败 → 标该 unit 失败，保留 worktree 供排查
            r.status = 'failed'
            r.error = `merge conflict: ${mergeErr}`
            r.worktreePath = wt.path
          } else {
            try {
              WorktreeService.remove(config.workspaceRoot, wt.name, true)
            } catch {
              // ignore cleanup failure
            }
          }
        } else {
          // 失败 unit：保留 worktree 供排查
          r.worktreePath = wt.path
        }
      }
    }

    // 写回单元 completed/failed 状态
    for (const r of results) {
      await hooks.onStatusChange(r.stepId, r.status === 'completed' ? 'completed' : 'pending')
      if (r.status === 'completed') completedUnitIds.add(r.stepId)
    }

    const waveReport: WaveReport = { waveIndex: wave.index, results }
    waveReports.push(waveReport)

    const failed = results.filter(r => r.status === 'failed')
    broadcast(IPC_CHANNELS.PARALLEL_WAVE_UPDATE, {
      waveIndex: wave.index,
      status: failed.length > 0 ? 'failed' : 'completed',
      stepResults: results,
    })

    // 失败即停
    if (failed.length > 0) {
      haltedAt = { waveIndex: wave.index, failedStepIds: failed.map(r => r.stepId) }
      break
    }
  }

  const report: ParallelExecutionReport = {
    source: hooks.source,
    planSlug: hooks.planSlug,
    status: haltedAt ? 'halted' : 'completed',
    waves: waveReports,
    haltedAt,
  }

  broadcast(IPC_CHANNELS.PARALLEL_EXEC_DONE, { report })
  return report
}

// ─── Worker spawn ──────────────────────────────────────────

async function spawnWorker(
  stepId: string,
  step: ExecUnit,
  isolation: 'shared' | 'worktree',
  worktree: { path: string; branch: string; name: string } | undefined,
  config: ParallelOrchestratorConfig,
  callbacks: AgentRunnerCallbacks
): Promise<StepResult> {
  const workspaceRoot = isolation === 'worktree' && worktree ? worktree.path : config.workspaceRoot
  const subAgentId = `worker_${step.id}_${Date.now()}`

  const task = [
    `Step ${step.id}: ${step.title}`,
    '',
    step.description,
    '',
    step.files && step.files.length > 0
      ? `Assigned files (stay within these): ${step.files.join(', ')}`
      : 'No specific files declared — infer from the description, but stay minimal.',
  ].join('\n')

  callbacks.onSubAgentStart?.(subAgentId, {
    type: 'Executor',
    description: step.title,
    prompt: task,
    parentToolCallId: config.parentToolCallId || subAgentId,
  })

  try {
    const result = await SubAgentManager.spawn(
      'Executor',
      {
        workspaceRoot,
        sessionId: config.sessionId,
        task,
        parentPrompt: task,
        subAgentId,
        permissionScope:
          isolation === 'worktree'
            ? { allowAllWritesInWorkspace: true, allowBash: true }
            : { allowedWriteFiles: step.files ?? [], allowBash: true },
        apiConfig: config.apiConfig,
      },
      callbacks
    )

    const output = normalizeWorkerResult(result as any)
    const stepResult: StepResult = {
      stepId,
      status: output.status,
      summary: output.summary,
      filesModified: output.filesModified,
      qualitySummary: result.qualitySummary as any,
      error: output.status === 'failed' ? (output.blockers?.join('; ') || 'worker reported failure') : undefined,
    }

    callbacks.onSubAgentEnd?.(subAgentId, {
      status: output.status,
      output: output.summary,
      qualitySummary: result.qualitySummary,
      toolCallCount: result.toolCallCount,
      conclusion: output.summary,
    })

    return stepResult
  } catch (err: any) {
    callbacks.onSubAgentEnd?.(subAgentId, { status: 'failed', toolCallCount: 0 })
    return {
      stepId,
      status: 'failed',
      summary: '',
      filesModified: [],
      error: `Worker crashed: ${err?.message ?? err}`,
    }
  }
}

// ─── 并发闸 ────────────────────────────────────────────────

/**
 * 以并发上限运行一组任务，全部完成后返回结果（保持输入顺序）。
 * 与 parallel 屏障语义一致：波是天然屏障。
 */
export async function runWithConcurrencyLimit<T>(
  thunks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results: T[] = new Array(thunks.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < thunks.length) {
      const idx = cursor++
      results[idx] = await thunks[idx]()
    }
  }

  const pool = Array.from({ length: Math.min(limit, thunks.length) }, () => worker())
  await Promise.all(pool)
  return results
}
