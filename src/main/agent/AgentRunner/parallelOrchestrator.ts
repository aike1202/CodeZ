import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../shared/ipc/channels'
import { WorktreeService } from '../../services/WorktreeService'
import { SubAgentManager } from '../SubAgentManager'
import type { AgentRunnerCallbacks } from './types'
import type { ModelContextCapabilities, ThinkingConfig } from '../../../shared/types/provider'
import type { SessionRuntimeCoordinator } from '../../services/context/SessionRuntimeCoordinator'
import type { ModelContextBuilder } from '../../services/context/ModelContextBuilder'
import type { CompactionService } from '../../services/context/CompactionService'
import type { EditTransactionService } from '../../services/EditTransactionService'
import { analyzePathImpactSync } from '../../services/permission/PathImpactAnalyzer'
import {
  canonicalMutationPath,
  getFileMutationCoordinator
} from '../../tools/FileMutationCoordinator'
import { getExecutionController } from '../../services/execution/ExecutionController'
import type {
  ExecUnit,
  ExecutorFailureReason,
  ExecutionGroupingResult,
  ExecutionWave,
  ParallelExecutionReport,
  StepResultStatus,
  StepResult,
  WaveReport,
} from '../../../shared/types/parallel'

// ─── 配置 ──────────────────────────────────────────────────

export interface ParallelOrchestratorConfig {
  workspaceRoot: string
  sessionId: string
  /** Provider identity used by durable SubAgent scopes to invalidate stale usage anchors. */
  providerId?: string
  /** 父工具调用 ID — Worker 的 parentToolCallId 设置为这个值，前端据此把 SubAgentCard 关联到 DelegateTasks */
  parentToolCallId?: string
  apiConfig: {
    baseUrl: string
    apiKey: string
    apiFormat: string
    model: string
    thinking?: ThinkingConfig
    contextWindowTokens?: number
    maxInputTokens?: number
    maxOutputTokens?: number
    reasoningCountsAgainstContext?: boolean
  }
  contextCapabilities?: ModelContextCapabilities
  runtimeCoordinator?: SessionRuntimeCoordinator
  contextBuilder?: ModelContextBuilder
  compactionService?: CompactionService
  /** Parent transaction used only by shared-workspace workers. */
  transactionId?: string
  editTransactionService?: EditTransactionService
  /** 父 Agent 停止时撤销本次 execution 及其所有 Executor 租约。 */
  parentSignal?: AbortSignal
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
  status: StepResultStatus
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
  status?: 'completed' | 'failed' | 'interrupted'
  structuredOutput?: Record<string, any>
  output?: string
  handoff?: import('../../../shared/types/subagent').SubAgentHandoff
  [key: string]: any
}): WorkerOutput {
  if (result.status === 'interrupted') {
    return {
      status: 'interrupted',
      summary: result.output?.trim() || 'Executor was interrupted before completion.',
      filesModified: result.handoff?.filesModified || [],
      blockers: [result.handoff?.reason || result.output || 'Executor interrupted.']
    }
  }
  if (result.status === 'failed') {
    const structured = result.structuredOutput ? parseWorkerOutput(result.structuredOutput) : undefined
    return {
      status: 'failed',
      summary: structured?.summary || result.output?.trim() || 'Executor failed.',
      filesModified: structured?.filesModified || result.handoff?.filesModified || [],
      blockers: structured?.blockers || [result.handoff?.reason || result.output || 'Executor failed.']
    }
  }
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

export function prepareWorktreeArtifact(
  wtName: string,
  wtPath: string
): { commit?: string; error: string | null } {
  try {
    gitInWorktree(wtPath, ['add', '-A'])
    if (hasStagedChanges(wtPath)) {
      gitInWorktree(wtPath, ['commit', '-m', `codez: worktree ${wtName}`])
    }
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: wtPath,
      timeout: 30_000,
      stdio: 'pipe',
      encoding: 'utf8'
    }).trim()
    return { commit, error: null }
  } catch (err: any) {
    return { error: `commit failed: ${formatGitError(err)}` }
  }
}

export interface PreparedWorktreeMergeResult {
  mergeError: string | null
  abortError: string | null
}

export function mergePreparedWorktree(
  workspaceRoot: string,
  branch: string
): PreparedWorktreeMergeResult {
  try {
    gitInWorktree(workspaceRoot, ['merge', '--no-edit', branch])
    return { mergeError: null, abortError: null }
  } catch (err: any) {
    let abortError: string | null = null
    try {
      gitInWorktree(workspaceRoot, ['merge', '--abort'])
    } catch (abortFailure) {
      abortError = formatGitError(abortFailure)
    }
    return {
      mergeError: formatGitError(err) || 'worktree merge failed',
      abortError
    }
  }
}

function formatPreparedMergeError(result: PreparedWorktreeMergeResult): string | null {
  if (!result.mergeError) return null
  return result.abortError
    ? `${result.mergeError}; git merge --abort also failed: ${result.abortError}`
    : result.mergeError
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
  const artifact = prepareWorktreeArtifact(wtName, wtPath)
  if (artifact.error) return artifact.error
  return formatPreparedMergeError(mergePreparedWorktree(workspaceRoot, branch))
}

interface RawDiffPath {
  relativePath: string
  oldMode: string
  newMode: string
}

function rawDiffPaths(workspaceRoot: string, from: string, to: string): RawDiffPath[] {
  const raw = execFileSync(
    'git',
    ['diff', '--raw', '-z', '--no-renames', '--abbrev=40', from, to],
    { cwd: workspaceRoot, timeout: 30_000, stdio: 'pipe', encoding: 'utf8' }
  )
  const fields = raw.split('\0')
  const entries: RawDiffPath[] = []
  for (let index = 0; index < fields.length;) {
    const header = fields[index++]
    if (!header) continue
    const match = header.match(
      /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z](?:\d+)?(?:\t([\s\S]*))?$/i
    )
    if (!match) throw new Error(`Cannot parse Git raw diff entry: ${header}`)
    const relativePath = match[3] ?? fields[index++]
    if (!relativePath) throw new Error('Git raw diff entry is missing its path')
    entries.push({ relativePath, oldMode: match[1], newMode: match[2] })
  }
  return entries
}

function assertSupportedMergeEntry(entry: RawDiffPath): void {
  const supported = new Set(['000000', '100644', '100755'])
  if (!supported.has(entry.oldMode) || !supported.has(entry.newMode)) {
    throw new Error(
      `Worktree merge refuses symlink, submodule, or special entry ${entry.relativePath} ` +
      `(${entry.oldMode} -> ${entry.newMode})`
    )
  }
}

function changedWorkspacePaths(workspaceRoot: string, branch: string): string[] {
  const mergeBase = execFileSync('git', ['merge-base', 'HEAD', branch], {
    cwd: workspaceRoot,
    timeout: 30_000,
    stdio: 'pipe',
    encoding: 'utf8'
  }).trim()
  const entries = [
    ...rawDiffPaths(workspaceRoot, mergeBase, 'HEAD'),
    ...rawDiffPaths(workspaceRoot, mergeBase, branch)
  ]
  for (const entry of entries) assertSupportedMergeEntry(entry)
  let realWorkspaceRoot = path.resolve(workspaceRoot)
  try {
    realWorkspaceRoot = fs.realpathSync.native(workspaceRoot)
  } catch {}
  return [...new Set(entries.map(({ relativePath }) => {
    const requestedPath = path.resolve(workspaceRoot, relativePath)
    const relative = path.relative(workspaceRoot, requestedPath)
    const impact = analyzePathImpactSync(requestedPath, workspaceRoot)
    const expectedPhysicalPath = path.resolve(realWorkspaceRoot, relativePath)
    if (
      !impact.insideWorkspace ||
      canonicalMutationPath(impact.resolvedPath) !== canonicalMutationPath(expectedPhysicalPath) ||
      relative === '' || relative === '..' ||
      relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ) {
      throw new Error(`Worktree merge path escapes the workspace: ${relativePath}`)
    }
    return impact.resolvedPath
  }))].sort()
}

function gitCommonDirectory(workspaceRoot: string): string {
  let commonDir: string
  try {
    commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: workspaceRoot, timeout: 30_000, stdio: 'pipe', encoding: 'utf8' }
    ).trim()
  } catch {
    const legacy = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: workspaceRoot,
      timeout: 30_000,
      stdio: 'pipe',
      encoding: 'utf8'
    }).trim()
    commonDir = path.isAbsolute(legacy) ? legacy : path.resolve(workspaceRoot, legacy)
  }
  if (!commonDir) throw new Error('Git common directory could not be resolved')
  return canonicalMutationPath(commonDir)
}

export interface ParentEditTransaction {
  id: string
  service: EditTransactionService
}

/** Merges a prepared branch while registering all workspace effects in the parent transaction. */
export async function mergePreparedWorktreeTracked(
  workspaceRoot: string,
  branch: string,
  parentTransaction?: ParentEditTransaction,
  abortSignal?: AbortSignal
): Promise<string | null> {
  try {
    const repoIdentity = gitCommonDirectory(workspaceRoot)
    await getFileMutationCoordinator().run(repoIdentity, async () => {
      const changedPaths = changedWorkspacePaths(workspaceRoot, branch)
      const merge = () => {
        const error = formatPreparedMergeError(mergePreparedWorktree(workspaceRoot, branch))
        if (error) throw new Error(error)
      }
      if (parentTransaction && changedPaths.length > 0) {
        await parentTransaction.service.runExternalMutation(
          parentTransaction.id,
          changedPaths,
          merge,
          abortSignal
        )
      } else {
        merge()
      }
    }, abortSignal)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export async function mergeWorktreeTracked(
  workspaceRoot: string,
  wtName: string,
  wtPath: string,
  branch: string,
  parentTransaction?: ParentEditTransaction,
  abortSignal?: AbortSignal
): Promise<string | null> {
  const artifact = prepareWorktreeArtifact(wtName, wtPath)
  if (artifact.error) return artifact.error
  return mergePreparedWorktreeTracked(
    workspaceRoot,
    branch,
    parentTransaction,
    abortSignal
  )
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
  const executionController = getExecutionController()

  // 1. 冲突校验（兜底守卫）
  const { error: validationError } = validateGrouping(waves, unitsById, isolation)
  if (validationError) {
    throw new Error(validationError)
  }

  const execution = executionController.createExecution({
    workspaceRoot: config.workspaceRoot,
    sessionId: config.sessionId,
    source: hooks.source,
    parentToolCallId: config.parentToolCallId,
    waves,
    isolation,
    rationale: grouping.rationale,
    parentSignal: config.parentSignal,
    executorDefinitions: Object.fromEntries(units.map((unit) => [
      unit.id,
      {
        task: buildWorkerTask(unit),
        context: buildWorkerContext(unit) || undefined,
        assignedFiles: unit.files || []
      }
    ]))
  })
  const executionId = execution.executionId
  executionController.startExecution(executionId)

  broadcast(IPC_CHANNELS.PARALLEL_EXEC_STARTED, {
    executionId,
    sessionId: config.sessionId,
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
    if (config.parentSignal?.aborted) {
      break
    }
    const stepIds = wave.stepIds.filter(id => unitsById.has(id) && !completedUnitIds.has(id))
    if (stepIds.length === 0) continue

    // 标记本波 units 为 in_progress
    for (const id of stepIds) {
      await hooks.onStatusChange(id, 'in_progress')
    }
    broadcast(IPC_CHANNELS.PARALLEL_WAVE_UPDATE, {
      executionId,
      sessionId: config.sessionId,
      waveIndex: wave.index,
      status: 'in_progress',
      stepResults: [],
    })

    // worktree 档：为每个 unit 建 worktree
    const worktrees = new Map<string, { path: string; branch: string; name: string }>()
    const worktreeSetupFailures = new Map<string, string>()
    if (isolation === 'worktree') {
      for (const id of stepIds) {
        const name = safeName(`${hooks.source}-${executionId}`, id)
        try {
          const info = WorktreeService.create(config.workspaceRoot, name)
          worktrees.set(id, { path: info.path, branch: info.branch, name })
        } catch (error) {
          const reason = `worktree setup failed: ${error instanceof Error ? error.message : String(error)}`
          worktreeSetupFailures.set(id, reason)
          executionController.failExecutorBeforeStart(executionId, id, reason)
        }
      }
    }

    // 组内并行 + 并发闸
    const results = await runWithConcurrencyLimit<StepResult>(
      stepIds.map(id => () => {
        const setupFailure = worktreeSetupFailures.get(id)
        if (setupFailure) {
          const snapshot = executionController.getExecution(executionId)?.executors.find((item) => item.stepId === id)
          return Promise.resolve<StepResult>({
            stepId: id,
            executorId: snapshot?.executorId,
            status: 'failed' as const,
            summary: '',
            filesModified: [],
            failureReason: 'runtime_error' as const,
            error: setupFailure
          })
        }
        return spawnWorker(
          executionId,
          id,
          unitsById.get(id)!,
          isolation,
          worktrees.get(id),
          config,
          callbacks
        )
      }),
      concurrencyLimit
    )

    const waveHasFailure = results.some((result) => result.status !== 'completed')

    // worktree 档：整波成功时沿用自动合并；部分成功时保留成功产物，等待主 Agent 接纳。
    if (isolation === 'worktree') {
      for (const r of results) {
        const wt = worktrees.get(r.stepId)
        if (!wt) continue
        if (r.status === 'completed') {
          if (waveHasFailure) {
            const artifact = prepareWorktreeArtifact(wt.name, wt.path)
            if (artifact.error) {
              r.status = 'failed'
              r.failureReason = 'runtime_error'
              r.error = artifact.error
              r.worktreePath = wt.path
            } else {
              r.worktreePath = wt.path
              r.artifactStatus = 'ready'
              r.artifactCommit = artifact.commit
              const executorId = r.executorId || executionController
                .getExecution(executionId)
                ?.executors.find((executor) => executor.stepId === r.stepId)
                ?.executorId
              if (executorId) {
                executionController.registerArtifact(executionId, executorId, async () => {
                  const mergeErr = await mergePreparedWorktreeTracked(
                    config.workspaceRoot,
                    wt.branch,
                    config.transactionId && config.editTransactionService
                      ? { id: config.transactionId, service: config.editTransactionService }
                      : undefined,
                    config.parentSignal
                  )
                  if (mergeErr) return `merge conflict: ${mergeErr}`
                  try { WorktreeService.remove(config.workspaceRoot, wt.name, true) } catch {}
                  await hooks.onStatusChange(r.stepId, 'completed')
                  completedUnitIds.add(r.stepId)
                  return null
                })
              }
            }
          } else {
            const mergeErr = await mergeWorktreeTracked(
              config.workspaceRoot,
              wt.name,
              wt.path,
              wt.branch,
              config.transactionId && config.editTransactionService
                ? { id: config.transactionId, service: config.editTransactionService }
                : undefined,
              config.parentSignal
            )
            if (mergeErr) {
              // 合并失败 → 标该 unit 失败，保留 worktree 供排查
              r.status = 'failed'
              r.failureReason = 'merge_conflict'
              r.error = `merge conflict: ${mergeErr}`
              r.worktreePath = wt.path
              r.artifactStatus = 'merge_conflict'
            } else {
              try { WorktreeService.remove(config.workspaceRoot, wt.name, true) } catch {}
              r.artifactStatus = 'merged'
            }
          }
        } else {
          // 失败 unit：保留 worktree 供排查
          r.worktreePath = wt.path
        }
      }
    }

    for (const result of results) {
      executionController.reconcileExecutorResult(executionId, result)
    }

    // 写回单元 completed/failed 状态
    for (const r of results) {
      const integrated = r.status === 'completed' && r.artifactStatus !== 'ready'
      await hooks.onStatusChange(r.stepId, integrated ? 'completed' : 'pending')
      if (integrated) completedUnitIds.add(r.stepId)
    }

    const waveReport: WaveReport = { waveIndex: wave.index, results }
    waveReports.push(waveReport)

    const failed = results.filter(r => r.status === 'failed')
    broadcast(IPC_CHANNELS.PARALLEL_WAVE_UPDATE, {
      executionId,
      sessionId: config.sessionId,
      waveIndex: wave.index,
      status: results.some((result) => result.status === 'interrupted')
        ? 'stopped'
        : failed.length > 0
          ? 'failed'
          : 'completed',
      stepResults: results,
    })

    // 失败即停
    const unsuccessful = results.filter(r => r.status !== 'completed')
    if (unsuccessful.length > 0) {
      haltedAt = { waveIndex: wave.index, failedStepIds: unsuccessful.map(r => r.stepId) }
      break
    }
  }

  const report: ParallelExecutionReport = {
    executionId,
    sessionId: config.sessionId,
    source: hooks.source,
    planSlug: hooks.planSlug,
    status: config.parentSignal?.aborted || executionController.getExecution(executionId)?.status === 'stopped'
      ? 'stopped'
      : haltedAt
        ? 'halted'
        : 'completed',
    waves: waveReports,
    haltedAt,
  }

  const hasReadyArtifacts = executionController
    .getExecution(executionId)
    ?.executors.some((executor) => executor.artifactStatus === 'ready')
  if (hasReadyArtifacts) executionController.markDecisionRequired(executionId)
  else executionController.markExecutionTerminal(executionId, report.status)
  broadcast(IPC_CHANNELS.PARALLEL_EXEC_DONE, {
    executionId,
    sessionId: config.sessionId,
    report
  })
  return report
}

// ─── Worker spawn ──────────────────────────────────────────

async function spawnWorker(
  executionId: string,
  stepId: string,
  step: ExecUnit,
  isolation: 'shared' | 'worktree',
  worktree: { path: string; branch: string; name: string } | undefined,
  config: ParallelOrchestratorConfig,
  callbacks: AgentRunnerCallbacks
): Promise<StepResult> {
  const workspaceRoot = isolation === 'worktree' && worktree ? worktree.path : config.workspaceRoot
  const executionController = getExecutionController()
  let attempt: ReturnType<typeof executionController.startExecutor>
  try {
    attempt = executionController.startExecutor(executionId, stepId)
  } catch (err: any) {
    const snapshot = executionController.getExecution(executionId)?.executors.find((item) => item.stepId === stepId)
    return {
      stepId,
      executorId: snapshot?.executorId,
      status: 'interrupted',
      summary: '',
      filesModified: [],
      failureReason: 'parent_interrupted',
      error: err?.message || String(err),
      worktreePath: worktree?.path
    }
  }
  const subAgentId = attempt.snapshot.subAgentId || attempt.snapshot.executorId
  const suppliedContext = buildWorkerContext(step)
  const task = buildWorkerTask(step)

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
        providerId: config.providerId,
        task,
        parentPrompt: task,
        context: suppliedContext || undefined,
        subAgentId,
        contextCapabilities: config.contextCapabilities,
        runtimeCoordinator: config.runtimeCoordinator,
        contextBuilder: config.contextBuilder,
        compactionService: config.compactionService,
        parentSignal: attempt.signal,
        controlToken: attempt.token,
        permissionScope:
          isolation === 'worktree'
            ? { allowAllWritesInWorkspace: true, allowBash: true }
            : { allowedWriteFiles: step.files ?? [], allowBash: false },
        transactionId: isolation === 'shared' ? config.transactionId : undefined,
        editTransactionService: isolation === 'shared' ? config.editTransactionService : undefined,
        apiConfig: config.apiConfig,
      },
      callbacks
    )

    const output = normalizeWorkerResult(result as any)
    const stepResult: StepResult = {
      stepId,
      executorId: attempt.snapshot.executorId,
      attemptId: attempt.token.attemptId,
      status: output.status,
      summary: output.summary,
      filesModified: output.filesModified,
      qualitySummary: result.qualitySummary as any,
      error: output.status !== 'completed' ? (output.blockers?.join('; ') || `Executor ${output.status}`) : undefined,
      failureReason: failureReasonFromResult(result),
      handoff: result.handoff,
    }
    executionController.finishExecutor(executionId, stepId, stepResult)

    callbacks.onSubAgentEnd?.(subAgentId, {
      status: output.status,
      output: output.summary,
      qualitySummary: result.qualitySummary,
      toolCallCount: result.toolCallCount,
      conclusion: output.summary,
      filesExamined: result.filesExamined,
      handoff: result.handoff,
    })

    return stepResult
  } catch (err: any) {
    const stepResult: StepResult = {
      stepId,
      executorId: attempt.snapshot.executorId,
      attemptId: attempt.token.attemptId,
      status: 'failed',
      summary: '',
      filesModified: [],
      failureReason: 'runtime_error',
      error: `Worker crashed: ${err?.message ?? err}`,
      worktreePath: worktree?.path
    }
    executionController.finishExecutor(executionId, stepId, stepResult)
    callbacks.onSubAgentEnd?.(subAgentId, {
      status: 'failed',
      output: stepResult.error,
      toolCallCount: 0
    })
    return stepResult
  }
}

export function buildWorkerContext(step: ExecUnit): string {
  const contextLines: string[] = []
  const appendContext = (heading: string, values: string[] | undefined) => {
    if (!values?.length) return
    contextLines.push(`### ${heading}`, ...values.map((value) => `- ${value}`), '')
  }
  appendContext('Known Facts', step.contextBundle?.knownFacts)
  appendContext('Implementation Decisions', step.contextBundle?.decisions)
  appendContext('Constraints', step.contextBundle?.constraints)
  appendContext('Do Not Re-investigate', step.contextBundle?.excludedDirections)
  appendContext('Source References', step.contextBundle?.sourceReferences)
  appendContext('Acceptance Criteria', step.acceptanceCriteria)
  if (step.verificationCommand) {
    contextLines.push('### Verification Command', step.verificationCommand, '')
  }
  return contextLines.join('\n').trim()
}

export function buildWorkerTask(step: ExecUnit): string {
  return [
    `Step ${step.id}: ${step.title}`,
    '',
    step.description,
    '',
    step.files && step.files.length > 0
      ? `Assigned files (stay within these): ${step.files.join(', ')}`
      : 'No specific files declared — infer from the description, but stay minimal.'
  ].join('\n')
}

export function failureReasonFromResult(result: {
  status?: string
  handoff?: import('../../../shared/types/subagent').SubAgentHandoff
}): ExecutorFailureReason | undefined {
  if (result.status === 'completed') return undefined
  const reason = result.handoff?.reasonCode
  if (reason === 'provider_error') return 'provider_error'
  if (reason === 'protocol_failure') return 'protocol_failure'
  if (reason === 'parent_interrupted') return 'parent_interrupted'
  if (reason === 'runtime_missing' || reason === 'parent_delivery_missing') return 'runtime_missing'
  return 'runtime_error'
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
