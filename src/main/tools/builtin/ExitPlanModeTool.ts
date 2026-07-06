import { Tool, ToolContext } from '../Tool'
import { PlanService } from '../../services/PlanService'
import * as path from 'path'
import * as fs from 'fs/promises'
import { PlanStore } from '../../services/PlanStore'

export class ExitPlanModeTool extends Tool {
  get name() {
    return 'ExitPlanMode'
  }

  get summary() {
    return 'Exit plan mode and return to normal execution.'
  }

  get description() {
    return 'Signal that the implementation plan has been written and is ready for user review. Call this tool after using WriteTool to save the plan file. The execution will pause here while the user reviews the plan. They may approve it or request changes.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        allowedPrompts: {
          type: 'array',
          description: 'Optional required permissions to run shell commands in the execution phase.',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', enum: ['Bash', 'PowerShell'] },
              prompt: { type: 'string', description: 'Description of the action, e.g., run tests' }
            },
            required: ['tool', 'prompt']
          }
        }
      }
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    // 实际执行逻辑会被 SubAgent 或 Tool 本身处理
    // 为了防止在普通 Agent 环境中直接调用，这里做一个基本的调用触发器
    // 正常情况下，Plan SubAgent 写入 .codez/plans/ 目录下的最新文件
    
    try {
      // 1. 找到最新修改的 Plan 文件
      const planStore = new PlanStore()
      const plansDir = planStore.getPlansDir(context.workspaceRoot)
      
      let entries: string[]
      try {
        entries = await fs.readdir(plansDir)
      } catch {
        return JSON.stringify({ ok: false, error: 'No plan directory found.' })
      }
      
      let latestFile = ''
      let latestTime = 0
      
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue
        const stat = await fs.stat(path.join(plansDir, entry))
        if (stat.mtimeMs > latestTime) {
          latestTime = stat.mtimeMs
          latestFile = entry
        }
      }
      
      if (!latestFile) {
        return JSON.stringify({ ok: false, error: 'No plan file found to submit.' })
      }
      
      const slug = path.basename(latestFile, '.md')
      
      // 2. 提交审查 (仅标记状态，真正的 review 挂起由调用方 AgentRunner 处理)
      await PlanService.submitForReview(context.workspaceRoot, slug)
      
      return JSON.stringify({
        ok: true,
        data: {
          status: 'pending_review',
          slug: slug,
          message: 'Plan submitted for review. This tool should be intercepted by SubAgent execution loop to handle the actual user review await.'
        }
      })
    } catch (err: any) {
      return JSON.stringify({ ok: false, error: err.message })
    }
  }
}
