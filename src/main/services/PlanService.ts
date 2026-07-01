import * as path from 'path'
import { createHash } from 'crypto'
import { PlanStore } from './PlanStore'
import type { Plan, PlanStatus, PlanStep, PlanStepStatus } from '../../shared/types/plan'

/**
 * Plan 业务逻辑层：状态机 + 业务规则。
 *
 * 状态机：
 *   drafting      --submitForReview-->  pending_review
 *   pending_review --approve-->         executing
 *   pending_review --requestChanges-->  drafting
 *   executing     --suspend-->          suspended
 *   suspended     --resume-->           executing
 *   executing     --complete-->         completed
 *   any           --abandon-->          abandoned
 *
 * 同一项目任一时刻最多 1 个 executing Plan（由 PlanStore.setActive 保证）。
 */
export class PlanService {
  private static store = new PlanStore()

  // ─── 查询 ────────────────────────────────────────────────────────

  static async loadPlan(workspaceRoot: string, slug: string): Promise<Plan | null> {
    return this.store.getBySlug(workspaceRoot, slug)
  }

  static async listPlans(workspaceRoot: string): Promise<Plan[]> {
    return this.store.list(workspaceRoot)
  }

  // ─── 创建 ────────────────────────────────────────────────────────

  /**
   * 创建一个新的 Plan，状态为 'drafting'。
   * 不会自动激活（即使已有 executing Plan 也保持 drafting）。
   */
  static async createPlan(
    workspaceRoot: string,
    title: string,
    description: string,
    steps: Array<{ title: string; description: string; files?: string[] }>
  ): Promise<Plan> {
    const slug = await this.generateUniqueSlug(workspaceRoot, title)
    const now = new Date().toISOString()
    const plan: Plan = {
      id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      slug,
      title,
      description,
      projectId: createHash('md5').update(path.resolve(workspaceRoot)).digest('hex'),
      steps: steps.map((step, i) => ({
        id: `p${i}`,
        title: step.title,
        description: step.description,
        status: 'pending' as PlanStepStatus,
        ...(step.files && step.files.length > 0 ? { files: step.files } : {})
      })),
      status: 'drafting',
      createdAt: now,
      updatedAt: now
    }
    await this.store.save(workspaceRoot, plan)
    return plan
  }

  // ─── 状态转移 ────────────────────────────────────────────────────

  /** drafting → pending_review */
  static async submitForReview(workspaceRoot: string, slug: string): Promise<Plan> {
    const plan = await this.requirePlan(workspaceRoot, slug)
    this.requireStatus(plan, 'drafting', 'submitForReview')
    plan.status = 'pending_review'
    plan.updatedAt = new Date().toISOString()
    await this.store.save(workspaceRoot, plan)
    return plan
  }

  /** pending_review → executing（调用 setActive，挂起其他 executing） */
  static async approve(workspaceRoot: string, slug: string): Promise<Plan> {
    const plan = await this.requirePlan(workspaceRoot, slug)
    this.requireStatus(plan, 'pending_review', 'approve')
    await this.store.setActive(workspaceRoot, slug)
    // setActive 已写入 executing 状态，重新读取返回最新值
    const updated = await this.store.getBySlug(workspaceRoot, slug)
    return updated ?? plan
  }

  /**
   * pending_review → drafting。
   * 将反馈追加到 description：`\n\n[Revision feedback: ${feedback}]`
   */
  static async requestChanges(workspaceRoot: string, slug: string, feedback: string): Promise<Plan> {
    const plan = await this.requirePlan(workspaceRoot, slug)
    this.requireStatus(plan, 'pending_review', 'requestChanges')
    plan.status = 'drafting'
    plan.description = `${plan.description}\n\n[Revision feedback: ${feedback}]`
    plan.updatedAt = new Date().toISOString()
    await this.store.save(workspaceRoot, plan)
    return plan
  }

  /** executing → suspended（记录原因） */
  static async suspend(workspaceRoot: string, slug: string, reason: string): Promise<Plan> {
    const plan = await this.requirePlan(workspaceRoot, slug)
    this.requireStatus(plan, 'executing', 'suspend')
    plan.status = 'suspended'
    plan.suspendedReason = reason
    plan.updatedAt = new Date().toISOString()
    await this.store.save(workspaceRoot, plan)
    return plan
  }

  /** suspended → executing（调用 setActive，挂起其他 executing） */
  static async resume(workspaceRoot: string, slug: string): Promise<Plan> {
    const plan = await this.requirePlan(workspaceRoot, slug)
    this.requireStatus(plan, 'suspended', 'resume')
    await this.store.setActive(workspaceRoot, slug)
    const updated = await this.store.getBySlug(workspaceRoot, slug)
    if (updated) {
      // setActive 不会清除 suspendedReason，此处恢复时清除
      updated.suspendedReason = undefined
      updated.updatedAt = new Date().toISOString()
      await this.store.save(workspaceRoot, updated)
      return updated
    }
    return plan
  }

  /** executing → completed */
  static async complete(workspaceRoot: string, slug: string): Promise<Plan> {
    const plan = await this.requirePlan(workspaceRoot, slug)
    this.requireStatus(plan, 'executing', 'complete')
    plan.status = 'completed'
    plan.updatedAt = new Date().toISOString()
    await this.store.save(workspaceRoot, plan)
    return plan
  }

  /** any → abandoned */
  static async abandon(workspaceRoot: string, slug: string): Promise<Plan> {
    const plan = await this.requirePlan(workspaceRoot, slug)
    plan.status = 'abandoned'
    plan.updatedAt = new Date().toISOString()
    await this.store.save(workspaceRoot, plan)
    return plan
  }

  // ─── 步骤更新 ────────────────────────────────────────────────────

  /**
   * 更新单个步骤。仅允许在 plan 处于 'executing' 时调用。
   * 若将某步骤设为 in_progress，则将其他 in_progress 步骤重置为 pending（同时只允许 1 个 in_progress）。
   */
  static async updateStep(
    workspaceRoot: string,
    slug: string,
    stepId: string,
    updates: { status?: PlanStepStatus; description?: string }
  ): Promise<Plan> {
    const plan = await this.requirePlan(workspaceRoot, slug)
    this.requireStatus(plan, 'executing', 'updateStep')

    const step = plan.steps.find(s => s.id === stepId)
    if (!step) {
      throw new Error(`Step '${stepId}' not found in plan '${slug}'`)
    }

    if (updates.status === 'in_progress') {
      for (const s of plan.steps) {
        if (s.id !== stepId && s.status === 'in_progress') {
          s.status = 'pending'
        }
      }
    }
    if (updates.status !== undefined) {
      step.status = updates.status
    }
    if (updates.description !== undefined) {
      step.description = updates.description
    }

    plan.updatedAt = new Date().toISOString()
    await this.store.save(workspaceRoot, plan)
    return plan
  }

  // ─── 内部工具 ────────────────────────────────────────────────────

  /**
   * 从 title 生成 kebab-case slug。
   * 若 title 全为非 ASCII（如中文），返回 'plan-<short-random>'。
   */
  private static generateSlug(title: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
    return slug || 'plan-' + Math.random().toString(36).slice(2, 8)
  }

  /**
   * 生成不冲突的 slug：若已存在则追加 '-2', '-3', ...
   */
  private static async generateUniqueSlug(workspaceRoot: string, title: string): Promise<string> {
    const base = this.generateSlug(title)
    const existing = await this.store.list(workspaceRoot)
    const taken = new Set(existing.map(p => p.slug))
    if (!taken.has(base)) return base
    let i = 2
    while (taken.has(`${base}-${i}`)) i++
    return `${base}-${i}`
  }

  private static async requirePlan(workspaceRoot: string, slug: string): Promise<Plan> {
    const plan = await this.store.getBySlug(workspaceRoot, slug)
    if (!plan) {
      throw new Error(`Plan '${slug}' not found`)
    }
    return plan
  }

  private static requireStatus(plan: Plan, expected: PlanStatus, action: string): void {
    if (plan.status !== expected) {
      throw new Error(
        `Cannot ${action} plan in status '${plan.status}' (expected '${expected}')`
      )
    }
  }
}
