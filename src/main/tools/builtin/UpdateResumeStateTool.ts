import { Tool, ToolContext } from '../Tool'
import { ContextManager, ResumeState } from '../../agent/ContextManager'

export class UpdateResumeStateTool extends Tool {
  get name() { return 'update_resume_state' }
  get description() { return '更新任务的核心上下文状态，包括当前目标、阶段、步骤、下一步、触碰文件与待验证项。长期任务推进或关键节点完成时应调用，防止对话历史被裁剪后丢失方向。' }
  
  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        currentGoalId: { type: 'string', description: '当前目标 ID，可用简短 slug。' },
        currentPhase: { type: 'string', description: '当前阶段，例如 implementation / verification / debugging。' },
        currentStep: { type: 'string', description: '当前正在进行的步骤。' },
        lastCompletedStep: { type: 'string', description: '最近完成的步骤。' },
        nextAction: { type: 'string', description: '恢复后下一步应执行的动作。' },
        openQuestions: { type: 'array', items: { type: 'string' }, description: '未解决问题。' },
        blockedBy: { type: 'array', items: { type: 'string' }, description: '阻塞项。' },
        filesTouched: { type: 'array', items: { type: 'string' }, description: '已修改或影响的文件。' },
        filesToInspectNext: { type: 'array', items: { type: 'string' }, description: '恢复后优先检查的文件。' },
        validationPending: { type: 'array', items: { type: 'string' }, description: '待运行或待确认的验证命令。' },
        goal: {
          type: 'object',
          description: '兼容旧结构：当前任务的目标摘要。',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            originalPrompt: { type: 'string', description: '原始需求或核心意图' },
            normalizedGoal: { type: 'string' },
            keyRequirements: { type: 'array', items: { type: 'string' }, description: '关键技术要求或验收标准' },
            nonGoals: { type: 'array', items: { type: 'string' } },
            successCriteria: { type: 'array', items: { type: 'string' } }
          }
        },
        plan: {
          type: 'object',
          description: '兼容旧结构：任务执行计划',
          properties: {
            currentStep: { type: 'string', description: '当前正在进行的具体步骤' },
            completedSteps: { type: 'array', items: { type: 'string' }, description: '已完成的步骤清单' },
            pendingSteps: { type: 'array', items: { type: 'string' }, description: '后续待执行的步骤清单' }
          }
        },
        contextFiles: {
          type: 'array',
          items: { type: 'string' },
          description: '当前任务强相关的上下文文件路径清单'
        }
      },
      required: ['currentPhase', 'currentStep', 'nextAction']
    }
  }

  async execute(argsStr: string, context: ToolContext): Promise<string> {
    const args = JSON.parse(argsStr)
    const legacyPlan = args.plan || {
      currentStep: args.currentStep,
      completedSteps: args.lastCompletedStep ? [args.lastCompletedStep] : [],
      pendingSteps: args.nextAction ? [args.nextAction] : []
    }
    const legacyGoal = args.goal || {
      originalPrompt: args.currentGoalId || 'current task',
      keyRequirements: []
    }

    const state: ResumeState = {
      currentGoalId: args.currentGoalId || legacyGoal.id || legacyGoal.title || 'current-goal',
      currentPhase: args.currentPhase,
      currentStep: args.currentStep || legacyPlan.currentStep || '',
      lastCompletedStep: args.lastCompletedStep,
      nextAction: args.nextAction,
      openQuestions: Array.isArray(args.openQuestions) ? args.openQuestions : [],
      blockedBy: Array.isArray(args.blockedBy) ? args.blockedBy : [],
      filesTouched: Array.isArray(args.filesTouched) ? args.filesTouched : [],
      filesToInspectNext: Array.isArray(args.filesToInspectNext) ? args.filesToInspectNext : [],
      validationPending: Array.isArray(args.validationPending) ? args.validationPending : [],
      goal: legacyGoal,
      plan: legacyPlan,
      contextFiles: Array.isArray(args.contextFiles) ? args.contextFiles : [],
      lastTrimmedAt: Date.now()
    }

    const stateKey = context.resumeStateKey || ContextManager.createResumeStateKey(context.workspaceRoot, context.sessionId)
    await ContextManager.saveResumeState(stateKey, state)

    return JSON.stringify({
      ok: true,
      resumeStateKey: stateKey,
      summary: `ResumeState updated for phase "${state.currentPhase}" step "${state.currentStep}".`,
      state
    }, null, 2)
  }
}
