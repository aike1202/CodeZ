import { PlanStore } from '../../services/PlanStore'
import { orchestrateParallelExecution } from './parallelOrchestrator'
import type { AgentRunnerCallbacks } from './types'
import type { ExecutionGroupingResult, ExecutionWave } from '../../../shared/types/parallel'

/**
 * ExecutePlanParallel 工具的拦截处理。
 *
 * 校验 Plan 存在且 executing → 归一化 grouping → 调用编排协调器 → 返回报告给主 Agent。
 * 与 handleSubAgentRunnerSpawn 同风格：返回 { ok, data } 结构的 tool 消息。
 */
export async function handleExecutePlanParallel(
  toolCallId: string,
  rawArgs: string,
  config: {
    workspaceRoot: string
    sessionId?: string
    baseUrl?: string
    apiKey?: string
    apiFormat?: string
    model?: string
    thinking?: any
  },
  callbacks: AgentRunnerCallbacks
): Promise<{ role: 'tool'; tool_call_id: string; name: string; content: string }> {
  const name = 'ExecutePlanParallel'

  const fail = (error: string) => {
    const msg = JSON.stringify({ ok: false, error })
    callbacks.onToolEnd?.(toolCallId, msg)
    return { role: 'tool' as const, tool_call_id: toolCallId, name, content: msg }
  }

  let parsed: {
    planSlug?: string
    grouping?: { waves?: ExecutionWave[]; isolation?: string; rationale?: string }
    isolation?: string
  }
  try {
    parsed = JSON.parse(rawArgs || '{}')
  } catch {
    return fail('Invalid JSON arguments for ExecutePlanParallel tool.')
  }

  if (!parsed.planSlug) {
    return fail('ExecutePlanParallel requires a `planSlug`.')
  }
  if (!parsed.grouping || !Array.isArray(parsed.grouping.waves)) {
    return fail('ExecutePlanParallel requires a `grouping` with a `waves` array.')
  }

  const planStore = new PlanStore()
  const plan = await planStore.getBySlug(config.workspaceRoot, parsed.planSlug)
  if (!plan) {
    return fail(`Plan '${parsed.planSlug}' not found.`)
  }
  if (plan.status !== 'executing') {
    return fail(`Plan '${parsed.planSlug}' is not executing (status: ${plan.status}). Approve it first.`)
  }

  // 最终隔离档：显式 isolation 优先，否则用 grouping 内的
  const isolation: 'shared' | 'worktree' =
    parsed.isolation === 'worktree' || parsed.isolation === 'shared'
      ? parsed.isolation
      : parsed.grouping.isolation === 'worktree'
        ? 'worktree'
        : 'shared'

  const grouping: ExecutionGroupingResult = {
    waves: parsed.grouping.waves.map((w, i) => ({
      index: typeof w.index === 'number' ? w.index : i,
      stepIds: Array.isArray(w.stepIds) ? w.stepIds : [],
    })),
    isolation,
    rationale: parsed.grouping.rationale || '',
  }

  try {
    // Plan → ExecUnit 适配：状态回写落 PlanStore
    const units = plan.steps.map(s => ({
      id: s.id,
      title: s.title,
      description: s.description,
      ...(s.files ? { files: s.files } : {}),
    }))
    const completedUnitIds = new Set(plan.steps.filter(s => s.status === 'completed').map(s => s.id))

    const report = await orchestrateParallelExecution(
      units,
      completedUnitIds,
      grouping,
      isolation,
      {
        source: `plan:${plan.slug}`,
        planSlug: plan.slug,
        onStatusChange: async (unitId, status) => {
          const step = plan.steps.find(s => s.id === unitId)
          if (step) {
            step.status = status
            await planStore.save(config.workspaceRoot, plan)
          }
        },
      },
      {
        workspaceRoot: config.workspaceRoot,
        sessionId: config.sessionId || 'session_default',
        parentToolCallId: toolCallId,
        apiConfig: {
          baseUrl: config.baseUrl || '',
          apiKey: config.apiKey || '',
          apiFormat: config.apiFormat || 'openai',
          model: config.model || '',
          thinking: config.thinking,
        },
      },
      callbacks
    )

    const resultMsg = JSON.stringify({ ok: true, data: report })
    callbacks.onToolEnd?.(toolCallId, resultMsg)
    return { role: 'tool' as const, tool_call_id: toolCallId, name, content: resultMsg }
  } catch (err: any) {
    return fail(`Parallel execution failed: ${err?.message ?? err}`)
  }
}
