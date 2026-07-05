import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import * as fs from 'fs/promises'
import { PlanService } from '../main/services/PlanService'
import { PlanStore } from '../main/services/PlanStore'

const tmpRoot = vi.hoisted(() => require('path').join(__dirname, 'tmp_plan_service'))

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue(tmpRoot) },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) }
}))

// Mock os.homedir so plans are written under the temp dir, not the real home
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    homedir: vi.fn().mockReturnValue(tmpRoot)
  }
})

describe('PlanService', () => {
  const workspaceRoot = path.join(__dirname, 'tmp_ws')
  const store = new PlanStore()

  beforeEach(async () => {
    await fs.mkdir(workspaceRoot, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(path.join(__dirname, 'tmp_plan_service'), { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  // ─── createPlan ─────────────────────────────────────────────────

  it('createPlan generates slug from English title', async () => {
    const plan = await PlanService.createPlan(
      workspaceRoot,
      'User Auth Flow',
      'Implement login and registration',
      [{ title: 'Step 1', description: 'desc' }]
    )
    expect(plan.slug).toBe('user-auth-flow')
    expect(plan.status).toBe('drafting')
    expect(plan.title).toBe('User Auth Flow')
  })

  it('createPlan generates plan-xxx slug for non-ASCII title', async () => {
    const plan = await PlanService.createPlan(
      workspaceRoot,
      '用户登录注册',
      '实现登录注册功能',
      [{ title: 'Step 1', description: 'desc' }]
    )
    expect(plan.slug).toMatch(/^plan-[a-z0-9]+$/)
  })

  it('createPlan resolves slug conflicts with -2, -3', async () => {
    await PlanService.createPlan(workspaceRoot, 'Auth Flow', 'desc', [{ title: 's', description: 'd' }])
    const second = await PlanService.createPlan(workspaceRoot, 'Auth Flow', 'desc', [{ title: 's', description: 'd' }])
    const third = await PlanService.createPlan(workspaceRoot, 'Auth Flow', 'desc', [{ title: 's', description: 'd' }])
    expect(second.slug).toBe('auth-flow-2')
    expect(third.slug).toBe('auth-flow-3')
  })

  it('createPlan creates steps p0, p1, ... with pending status', async () => {
    const plan = await PlanService.createPlan(
      workspaceRoot,
      'Multi Step',
      'desc',
      [
        { title: 'First', description: 'd1', files: ['a.ts'] },
        { title: 'Second', description: 'd2' }
      ]
    )
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0].id).toBe('p0')
    expect(plan.steps[0].title).toBe('First')
    expect(plan.steps[0].status).toBe('pending')
    expect(plan.steps[0].files).toEqual(['a.ts'])
    expect(plan.steps[1].id).toBe('p1')
    expect(plan.steps[1].status).toBe('pending')
  })

  it('createPlan does not auto-activate (stays drafting even if another plan is executing)', async () => {
    // Create and activate a first plan
    const first = await PlanService.createPlan(workspaceRoot, 'First Plan', 'desc', [{ title: 's', description: 'd' }])
    await store.save(workspaceRoot, { ...first, status: 'executing' })

    // Create a second plan
    const second = await PlanService.createPlan(workspaceRoot, 'Second Plan', 'desc', [{ title: 's', description: 'd' }])
    expect(second.status).toBe('drafting')

    // The first plan should still be executing
    const firstReloaded = await store.getBySlug(workspaceRoot, first.slug)
    expect(firstReloaded!.status).toBe('executing')
  })

  // ─── submitForReview ─────────────────────────────────────────────

  it('submitForReview: drafting → pending_review', async () => {
    const plan = await PlanService.createPlan(workspaceRoot, 'Review Me', 'desc', [{ title: 's', description: 'd' }])
    const updated = await PlanService.submitForReview(workspaceRoot, plan.slug)
    expect(updated.status).toBe('pending_review')
  })

  it('submitForReview throws on wrong status', async () => {
    const plan = await PlanService.createPlan(workspaceRoot, 'Wrong Status', 'desc', [{ title: 's', description: 'd' }])
    await store.save(workspaceRoot, { ...plan, status: 'executing' })
    await expect(PlanService.submitForReview(workspaceRoot, plan.slug)).rejects.toThrow(/pending_review|drafting/)
  })

  // ─── approve ─────────────────────────────────────────────────────

  it('approve: pending_review → executing (calls setActive)', async () => {
    const plan = await PlanService.createPlan(workspaceRoot, 'Approve Me', 'desc', [{ title: 's', description: 'd' }])
    await store.save(workspaceRoot, { ...plan, status: 'pending_review' })
    const updated = await PlanService.approve(workspaceRoot, plan.slug)
    expect(updated.status).toBe('executing')
    // setActive should have suspended other executing plans
    const active = await store.getActive(workspaceRoot)
    expect(active!.slug).toBe(plan.slug)
  })

  it('approve throws on wrong status', async () => {
    const plan = await PlanService.createPlan(workspaceRoot, 'Not Pending', 'desc', [{ title: 's', description: 'd' }])
    // still drafting
    await expect(PlanService.approve(workspaceRoot, plan.slug)).rejects.toThrow(/pending_review/)
  })

  // ─── requestChanges ──────────────────────────────────────────────

  it('requestChanges: pending_review → drafting, appends feedback', async () => {
    const plan = await PlanService.createPlan(workspaceRoot, 'Needs Changes', 'original desc', [{ title: 's', description: 'd' }])
    await store.save(workspaceRoot, { ...plan, status: 'pending_review' })
    const updated = await PlanService.requestChanges(workspaceRoot, plan.slug, 'please add more steps')
    expect(updated.status).toBe('drafting')
    expect(updated.description).toContain('original desc')
    expect(updated.description).toContain('[Revision feedback: please add more steps]')
  })

  // ─── suspend / resume ────────────────────────────────────────────

  it('suspend: executing → suspended with reason', async () => {
    const plan = await PlanService.createPlan(workspaceRoot, 'Suspend Me', 'desc', [{ title: 's', description: 'd' }])
    await store.save(workspaceRoot, { ...plan, status: 'executing' })
    const updated = await PlanService.suspend(workspaceRoot, plan.slug, 'waiting on design')
    expect(updated.status).toBe('suspended')
    expect(updated.suspendedReason).toBe('waiting on design')
  })

  it('suspend throws on wrong status', async () => {
    const plan = await PlanService.createPlan(workspaceRoot, 'Not Executing', 'desc', [{ title: 's', description: 'd' }])
    await expect(PlanService.suspend(workspaceRoot, plan.slug, 'r')).rejects.toThrow(/executing/)
  })

  it('resume: suspended → executing (calls setActive)', async () => {
    const plan = await PlanService.createPlan(workspaceRoot, 'Resume Me', 'desc', [{ title: 's', description: 'd' }])
    await store.save(workspaceRoot, { ...plan, status: 'suspended', suspendedReason: 'old' })
    const updated = await PlanService.resume(workspaceRoot, plan.slug)
    expect(updated.status).toBe('executing')
    expect(updated.suspendedReason).toBeUndefined()
    const active = await store.getActive(workspaceRoot)
    expect(active!.slug).toBe(plan.slug)
  })

  it('resume throws on wrong status', async () => {
    const plan = await PlanService.createPlan(workspaceRoot, 'Not Suspended', 'desc', [{ title: 's', description: 'd' }])
    await expect(PlanService.resume(workspaceRoot, plan.slug)).rejects.toThrow(/suspended/)
  })

  // ─── complete ────────────────────────────────────────────────────

  it('complete: executing → completed', async () => {
    const plan = await PlanService.createPlan(workspaceRoot, 'Complete Me', 'desc', [{ title: 's', description: 'd' }])
    await store.save(workspaceRoot, { ...plan, status: 'executing' })
    const updated = await PlanService.complete(workspaceRoot, plan.slug)
    expect(updated.status).toBe('completed')
  })

  it('complete throws on wrong status', async () => {
    const plan = await PlanService.createPlan(workspaceRoot, 'Not Executing', 'desc', [{ title: 's', description: 'd' }])
    await expect(PlanService.complete(workspaceRoot, plan.slug)).rejects.toThrow(/executing/)
  })

  // ─── abandon ─────────────────────────────────────────────────────

  it('abandon: any status → abandoned', async () => {
    const plan = await PlanService.createPlan(workspaceRoot, 'Abandon Me', 'desc', [{ title: 's', description: 'd' }])
    // drafting → abandoned
    const fromDraft = await PlanService.abandon(workspaceRoot, plan.slug)
    expect(fromDraft.status).toBe('abandoned')

    // executing → abandoned
    const plan2 = await PlanService.createPlan(workspaceRoot, 'Abandon Executing', 'desc', [{ title: 's', description: 'd' }])
    await store.save(workspaceRoot, { ...plan2, status: 'executing' })
    const fromExec = await PlanService.abandon(workspaceRoot, plan2.slug)
    expect(fromExec.status).toBe('abandoned')
  })

  // ─── updateStep ──────────────────────────────────────────────────

  it('updateStep: updates step status', async () => {
    const plan = await PlanService.createPlan(workspaceRoot, 'Update Step', 'desc', [
      { title: 'A', description: 'd1' },
      { title: 'B', description: 'd2' }
    ])
    await store.save(workspaceRoot, { ...plan, status: 'executing' })
    const updated = await PlanService.updateStep(workspaceRoot, plan.slug, 'p0', { status: 'in_progress' })
    expect(updated.steps[0].status).toBe('in_progress')
    expect(updated.steps[1].status).toBe('pending')
  })

  it('updateStep: setting in_progress resets other in_progress steps', async () => {
    const plan = await PlanService.createPlan(workspaceRoot, 'Reset Others', 'desc', [
      { title: 'A', description: 'd1' },
      { title: 'B', description: 'd2' }
    ])
    await store.save(workspaceRoot, {
      ...plan,
      status: 'executing',
      steps: [
        { id: 'p0', title: 'A', description: 'd1', status: 'in_progress' },
        { id: 'p1', title: 'B', description: 'd2', status: 'pending' }
      ]
    })
    const updated = await PlanService.updateStep(workspaceRoot, plan.slug, 'p1', { status: 'in_progress' })
    expect(updated.steps[0].status).toBe('pending') // reset
    expect(updated.steps[1].status).toBe('in_progress')
  })

  it('updateStep throws if plan not executing', async () => {
    const plan = await PlanService.createPlan(workspaceRoot, 'Not Executing Step', 'desc', [{ title: 'A', description: 'd1' }])
    // still drafting
    await expect(PlanService.updateStep(workspaceRoot, plan.slug, 'p0', { status: 'in_progress' })).rejects.toThrow(/executing/)
  })

  it('updateStep: updates step description', async () => {
    const plan = await PlanService.createPlan(workspaceRoot, 'Update Desc', 'desc', [{ title: 'A', description: 'd1' }])
    await store.save(workspaceRoot, { ...plan, status: 'executing' })
    const updated = await PlanService.updateStep(workspaceRoot, plan.slug, 'p0', { description: 'new desc' })
    expect(updated.steps[0].description).toBe('new desc')
  })

  // ─── loadPlan / listPlans ────────────────────────────────────────

  it('loadPlan returns null for non-existent slug', async () => {
    const plan = await PlanService.loadPlan(workspaceRoot, 'nonexistent')
    expect(plan).toBeNull()
  })

  it('listPlans returns created plans', async () => {
    await PlanService.createPlan(workspaceRoot, 'Plan One', 'desc', [{ title: 's', description: 'd' }])
    await PlanService.createPlan(workspaceRoot, 'Plan Two', 'desc', [{ title: 's', description: 'd' }])
    const plans = await PlanService.listPlans(workspaceRoot)
    expect(plans).toHaveLength(2)
  })
})
