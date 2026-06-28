import { Tool, ToolContext } from '../Tool'
import { ContextManager, ResumeState } from '../../agent/ContextManager'

export class UpdateResumeStateTool extends Tool {
  get name() { return 'update_resume_state' }
  get description() { return '更新任务的核心上下文状态 (Goal, TaskPlan, ContextFiles)。当长期任务推进或关键节点完成时，调用此工具更新状态，防止对话历史被裁剪后丢失方向。' }
  
  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        goal: {
          type: 'object',
          description: '当前任务的终极目标',
          properties: {
            originalPrompt: { type: 'string', description: '原始需求或核心意图' },
            keyRequirements: { type: 'array', items: { type: 'string' }, description: '关键技术要求或验收标准' }
          },
          required: ['originalPrompt', 'keyRequirements']
        },
        plan: {
          type: 'object',
          description: '任务执行计划',
          properties: {
            currentStep: { type: 'string', description: '当前正在进行的具体步骤' },
            completedSteps: { type: 'array', items: { type: 'string' }, description: '已完成的步骤清单' },
            pendingSteps: { type: 'array', items: { type: 'string' }, description: '后续待执行的步骤清单' }
          },
          required: ['currentStep', 'completedSteps', 'pendingSteps']
        },
        contextFiles: {
          type: 'array',
          items: { type: 'string' },
          description: '当前任务强相关的上下文文件路径清单'
        }
      },
      required: ['goal', 'plan', 'contextFiles']
    }
  }

  async execute(argsStr: string, context: ToolContext): Promise<string> {
    const args = JSON.parse(argsStr)
    const state: ResumeState = {
      goal: args.goal,
      plan: args.plan,
      contextFiles: args.contextFiles,
      lastTrimmedAt: Date.now()
    }

    const sessionId = context.transactionId ? context.transactionId.split('_').slice(0, -1).join('_') : 'unknown_session'
    
    // In AgentRunner, txId = `tx_${Date.now()}_...` which doesn't include sessionId.
    // However, ContextManager loadResumeState takes sessionId. We should probably use the same logic or pass sessionId to ToolContext.
    // Let's add sessionId to ToolContext in AgentRunner, but if we don't want to change ITool interface too much:
    // Let's use workspace hash as sessionId for now, or just a constant 'current'.
    const crypto = require('crypto')
    const wsHash = crypto.createHash('md5').update(context.workspaceRoot).digest('hex')
    const stateSessionId = `workspace_${wsHash}`

    await ContextManager.saveResumeState(stateSessionId, state)

    return 'ResumeState updated successfully. Context is now protected against truncation.'
  }
}
