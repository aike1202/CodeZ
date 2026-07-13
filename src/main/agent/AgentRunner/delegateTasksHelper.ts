import { orchestrateParallelExecution } from './parallelOrchestrator'
import { TaskStore } from '../../services/TaskStore'
import { WorktreeService } from '../../services/WorktreeService'
import type { AgentRunConfig, AgentRunnerCallbacks } from './types'
import type { ExecUnit, ExecutionGroupingResult, ExecutionWave, ParallelExecutionReport } from '../../../shared/types/parallel'
import type { TaskItem } from '../../../shared/types/task'
import type { EditTransactionService } from '../../services/EditTransactionService'

export function resolveDelegateIsolation(
  requestedIsolation: unknown,
  workspaceRoot: string
): { isolation: 'shared' | 'worktree'; fallbackReason?: string } {
  const preferred: 'shared' | 'worktree' = requestedIsolation === 'shared' ? 'shared' : 'worktree'
  if (preferred === 'worktree' && !WorktreeService.isGitRepository(workspaceRoot)) {
    return {
      isolation: 'shared',
      fallbackReason: '当前目录不是 Git 仓库，已从 worktree 隔离自动改用 shared 共享工作区模式。',
    }
  }
  return { isolation: preferred }
}

export function validateSharedDelegationReadiness(units: ExecUnit[]): string | null {
  const missing = units.filter(u => !u.files || u.files.length === 0).map(u => u.id)
  if (missing.length > 0) {
    return `Shared Worker delegation requires every task to declare \`files\`; missing: ${missing.join(', ')}. Add file boundaries or run these tasks sequentially.`
  }
  return null
}

function filesConflict(a: ExecUnit, b: ExecUnit): boolean {
  const filesA = new Set(a.files ?? [])
  return (b.files ?? []).some(f => filesA.has(f))
}

export function compactIndependentSingletonWaves(
  waves: ExecutionWave[],
  _unitsById: Map<string, ExecUnit>
): ExecutionWave[] {
  // File disjointness cannot prove logical independence. Preserve the grouping
  // chosen by the main Agent/ExecutionPlanner exactly.
  return waves.map((wave) => ({ index: wave.index, stepIds: [...wave.stepIds] }))
}

export function collectDelegatedTerminalTasks(
  report: ParallelExecutionReport,
  tasks: TaskItem[]
): TaskItem[] {
  const completedIds = new Set(
    report.waves.flatMap((wave) => wave.results)
      .filter((result) => result.status === 'completed')
      .map((result) => result.stepId)
  )

  return tasks
    .filter((task) => completedIds.has(task.id) && (task.status === 'completed' || task.status === 'cancelled'))
    .map((task) => ({ ...task }))
}

/**
 * DelegateTasks 工具的拦截处理。
 *
 * 读取会话 Task → 映射为 ExecUnit → 调解耦后的 orchestrator 跑 Worker →
 * ExecutionController 事件实时投影回 TaskStore → 返回报告给主 Agent。
 */
export async function handleDelegateTasks(
  toolCallId: string,
  rawArgs: string,
  config: AgentRunConfig,
  callbacks: AgentRunnerCallbacks,
  parentSignal?: AbortSignal,
  parentTransaction?: { id: string; service: EditTransactionService }
): Promise<{ role: 'tool'; tool_call_id: string; name: string; content: string }> {
  const name = 'DelegateTasks'

  const fail = (error: string) => {
    const msg = JSON.stringify({ ok: false, error })
    callbacks.onToolEnd?.(toolCallId, msg)
    return { role: 'tool' as const, tool_call_id: toolCallId, name, content: msg }
  }

  const sessionId = config.sessionId
  if (!sessionId) {
    return fail('DelegateTasks requires an active session.')
  }

  let parsed: {
    waves?: Array<{ index?: number; taskIds?: string[] }>
    isolation?: string
    rationale?: string
  }
  try {
    parsed = JSON.parse(rawArgs || '{}')
  } catch {
    return fail('Invalid JSON arguments for DelegateTasks.')
  }

  if (!Array.isArray(parsed.waves) || parsed.waves.length === 0) {
    return fail('DelegateTasks requires a non-empty `waves` array.')
  }

  const store = TaskStore.getInstance()
  const allTasks = store.list(sessionId)
  if (allTasks.length === 0) {
    return fail('No tasks exist in this session. Create them with TaskCreate first.')
  }

  // 归一化波次；校验引用的 taskId 都存在
  let waves: ExecutionWave[] = parsed.waves.map((w, i) => ({
    index: typeof w.index === 'number' ? w.index : i,
    stepIds: Array.isArray(w.taskIds) ? w.taskIds : [],
  }))
  const duplicateWaveIndexes = waves
    .map((wave) => wave.index)
    .filter((index, position, all) => all.indexOf(index) !== position)
  if (duplicateWaveIndexes.length > 0) {
    return fail(`Duplicate wave index(es): ${Array.from(new Set(duplicateWaveIndexes)).join(', ')}.`)
  }
  const allReferencedIds = waves.flatMap((wave) => wave.stepIds)
  const duplicateTaskIds = allReferencedIds.filter((id, position) => allReferencedIds.indexOf(id) !== position)
  if (duplicateTaskIds.length > 0) {
    return fail(`A task may appear in only one wave; duplicate task id(s): ${Array.from(new Set(duplicateTaskIds)).join(', ')}.`)
  }
  if (waves.some((wave) => wave.stepIds.length === 0)) {
    return fail('DelegateTasks does not allow empty waves.')
  }
  const referenced = new Set(waves.flatMap(w => w.stepIds))
  const unknown = [...referenced].filter(id => !allTasks.some(t => t.id === id))
  if (unknown.length > 0) {
    return fail(`Unknown task id(s): ${unknown.join(', ')}. Use TaskList to see valid ids.`)
  }

  // Task → ExecUnit
  const units: ExecUnit[] = allTasks
    .filter(t => referenced.has(t.id))
    .map(t => ({
      id: t.id,
      title: t.subject,
      description: t.description,
      ...(t.files ? { files: t.files } : {}),
      ...(t.contextBundle ? { contextBundle: t.contextBundle } : {}),
      ...(t.acceptanceCriteria ? { acceptanceCriteria: t.acceptanceCriteria } : {}),
      ...(t.verificationCommand ? { verificationCommand: t.verificationCommand } : {}),
    }))

  const completedUnitIds = new Set(
    allTasks.filter(t => t.status === 'completed' && referenced.has(t.id)).map(t => t.id)
  )

  const isolationResolution = resolveDelegateIsolation(parsed.isolation, config.workspaceRoot)
  const isolation = isolationResolution.isolation
  const runnableUnits = units.filter(u => !completedUnitIds.has(u.id))
  if (isolation === 'shared') {
    const sharedReadinessError = validateSharedDelegationReadiness(runnableUnits)
    if (sharedReadinessError) {
      return fail(sharedReadinessError)
    }
  }

  const grouping: ExecutionGroupingResult = {
    waves,
    isolation,
    rationale: parsed.rationale || '',
  }

  // ─── 用户确认：展示分派方案 ───────────────────────────
  if (callbacks.onAskUserRequest) {
    const taskById = new Map(allTasks.map(t => [t.id, t]))
    const waveLines = waves.map((w, i) => {
      const names = w.stepIds
        .map(id => {
          const t = taskById.get(id)
          return t ? `**${id}** ${t.subject}` : id
        })
        .join('、')
      return `**第${i + 1}波**（WorkerAgent ${w.stepIds.length > 1 ? w.stepIds.map(() => 'X').join('+') : String(w.stepIds.length)}）：${names}`
    })
    const totalWorkers = waves.reduce((sum, w) => sum + w.stepIds.length, 0)
    const header = `🚀 多 Worker 并行执行（共 ${waves.length} 波 ${totalWorkers} 个 Worker）`

    const answers = await callbacks.onAskUserRequest({
      id: `delegate_confirm_${Date.now()}`,
      questions: [
        {
          question: [
            `Agent 建议将 ${referenced.size} 个任务分派给 ${totalWorkers} 个 Worker 子代理并行执行：`,
            '',
            ...waveLines,
            '',
            `隔离模式：**${isolation === 'worktree' ? '独立工作区 (worktree)' : '共享工作区 (shared)'}**`,
            ...(isolationResolution.fallbackReason ? [`说明：${isolationResolution.fallbackReason}`] : []),
            `理由：${grouping.rationale || '未提供'}`
          ].join('\n'),
          header,
          options: [
            {
              label: '同意并行分派',
              description: `${totalWorkers} 个 Worker 子代理将按 ${waves.length} 波并行执行；波内并发、波间串行，失败即停。`
            },
            {
              label: '逐个执行（不分派）',
              description: '主 Agent 将按任务列表顺序逐个完成，不使用 Worker 子代理。'
            }
          ],
          multiSelect: false
        }
      ]
    })

    const ans = answers?.[0]?.answer as string
    if (ans === 'reject') {
      // 用户选择逐个执行 → 返回提示让主 Agent 手动逐个做
      const msg = JSON.stringify({
        ok: true,
        data: {
          status: 'user_chose_sequential',
          message: 'User chose sequential execution. Proceed task by task with TaskUpdate, one at a time.',
          tasks: allTasks.filter(t => referenced.has(t.id)).map(t => ({ id: t.id, subject: t.subject, status: t.status }))
        }
      })
      callbacks.onToolEnd?.(toolCallId, msg)
      return { role: 'tool' as const, tool_call_id: toolCallId, name, content: msg }
    }
    // 同意（ans === 'approve'）→ 继续执行
  }

  try {
    const report = await orchestrateParallelExecution(
      units,
      completedUnitIds,
      grouping,
      isolation,
      {
        source: `task:${sessionId}`,
        // TaskStore subscribes to ExecutionController and receives per-Executor
        // transitions. Wave-level hooks would incorrectly mark queued tasks running.
        onStatusChange: () => undefined,
      },
      {
        workspaceRoot: config.workspaceRoot,
        sessionId,
        providerId: config.providerId,
        parentToolCallId: toolCallId,
        apiConfig: {
          baseUrl: config.baseUrl || '',
          apiKey: config.apiKey || '',
          apiFormat: config.apiFormat || 'openai',
          model: config.model || '',
          thinking: config.thinking,
          contextWindowTokens: config.contextCapabilities?.contextWindowTokens,
          maxInputTokens: config.contextCapabilities?.maxInputTokens,
          maxOutputTokens: config.contextCapabilities?.maxOutputTokens,
          reasoningCountsAgainstContext: config.contextCapabilities?.reasoningCountsAgainstContext,
        },
        contextCapabilities: config.contextCapabilities,
        runtimeCoordinator: config.runtimeCoordinator,
        contextBuilder: config.contextBuilder,
        compactionService: config.compactionService,
        parentSignal,
        transactionId: parentTransaction?.id,
        editTransactionService: parentTransaction?.service,
      },
      callbacks
    )

    const terminalTasks = collectDelegatedTerminalTasks(report, store.list(sessionId))
    const resultMsg = JSON.stringify({
      ok: true,
      data: {
        ...report,
        terminalTasks
      }
    })
    callbacks.onToolEnd?.(toolCallId, resultMsg)
    return { role: 'tool' as const, tool_call_id: toolCallId, name, content: resultMsg }
  } catch (err: any) {
    return fail(`Task delegation failed: ${err?.message ?? err}`)
  }
}
