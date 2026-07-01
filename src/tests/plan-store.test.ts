import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as os from 'os'
import { PlanStore } from '../main/services/PlanStore'
import type { Plan } from '../shared/types/plan'

const tmpRoot = vi.hoisted(() => require('path').join(__dirname, 'tmp_plan_store'))

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue(tmpRoot) }
}))

// Mock os.homedir so plans are written under the temp dir, not the real home
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    homedir: vi.fn().mockReturnValue(tmpRoot)
  }
})

describe('PlanStore', () => {
  const workspaceRoot = path.join(__dirname, 'tmp_ws')
  let store: PlanStore

  beforeEach(async () => {
    await fs.mkdir(workspaceRoot, { recursive: true })
    store = new PlanStore()
  })

  afterEach(async () => {
    await fs.rm(path.join(__dirname, 'tmp_plan_store'), { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  const makePlan = (overrides: Partial<Plan> = {}): Plan => ({
    id: 'plan-1',
    slug: 'user-auth-flow',
    title: '用户登录注册',
    description: '实现登录注册',
    projectId: 'hash1',
    steps: [
      { id: 'p0', title: '搭建模型', description: '创建 User schema', status: 'pending' },
      { id: 'p1', title: '注册接口', description: 'POST /register', status: 'pending' }
    ],
    status: 'drafting',
    createdAt: '2026-07-01T10:00:00Z',
    updatedAt: '2026-07-01T10:00:00Z',
    ...overrides
  })

  it('save then list should round-trip a plan', async () => {
    const plan = makePlan()
    await store.save(workspaceRoot, plan)
    const plans = await store.list(workspaceRoot)
    expect(plans).toHaveLength(1)
    expect(plans[0].slug).toBe('user-auth-flow')
    expect(plans[0].title).toBe('用户登录注册')
    expect(plans[0].steps).toHaveLength(2)
    expect(plans[0].steps[0].id).toBe('p0')
  })

  it('getBySlug should return the plan', async () => {
    await store.save(workspaceRoot, makePlan())
    const found = await store.getBySlug(workspaceRoot, 'user-auth-flow')
    expect(found).toBeTruthy()
    expect(found!.id).toBe('plan-1')
  })

  it('getBySlug should return null for non-existent slug', async () => {
    const found = await store.getBySlug(workspaceRoot, 'nonexistent')
    expect(found).toBeNull()
  })

  it('delete should remove the plan file', async () => {
    await store.save(workspaceRoot, makePlan())
    await store.delete(workspaceRoot, 'user-auth-flow')
    const plans = await store.list(workspaceRoot)
    expect(plans).toHaveLength(0)
  })

  it('getActive should return the only executing plan', async () => {
    await store.save(workspaceRoot, makePlan({ slug: 'a', status: 'executing' }))
    await store.save(workspaceRoot, makePlan({ id: 'plan-2', slug: 'b', status: 'suspended' }))
    const active = await store.getActive(workspaceRoot)
    expect(active).toBeTruthy()
    expect(active!.slug).toBe('a')
  })

  it('getActive should return null when no executing plan', async () => {
    await store.save(workspaceRoot, makePlan({ status: 'suspended' }))
    const active = await store.getActive(workspaceRoot)
    expect(active).toBeNull()
  })

  it('setActive should set target to executing and suspend others', async () => {
    await store.save(workspaceRoot, makePlan({ slug: 'a', status: 'executing' }))
    await store.save(workspaceRoot, makePlan({ id: 'plan-2', slug: 'b', status: 'suspended' }))
    await store.setActive(workspaceRoot, 'b')
    const a = await store.getBySlug(workspaceRoot, 'a')
    const b = await store.getBySlug(workspaceRoot, 'b')
    expect(a!.status).toBe('suspended')
    expect(b!.status).toBe('executing')
  })

  it('save should update existing plan (upsert by slug)', async () => {
    await store.save(workspaceRoot, makePlan({ status: 'drafting' }))
    await store.save(workspaceRoot, makePlan({ status: 'pending_review' }))
    const plans = await store.list(workspaceRoot)
    expect(plans).toHaveLength(1)
    expect(plans[0].status).toBe('pending_review')
  })

  it('list should return empty array for new workspace', async () => {
    const plans = await store.list(workspaceRoot)
    expect(plans).toEqual([])
  })

  it('should preserve step files and status across save/load', async () => {
    const plan = makePlan({
      steps: [
        { id: 'p0', title: 'A', description: 'desc', status: 'completed', files: ['src/a.ts', 'src/b.ts'] },
        { id: 'p1', title: 'B', description: 'desc', status: 'in_progress' }
      ]
    })
    await store.save(workspaceRoot, plan)
    const loaded = await store.getBySlug(workspaceRoot, 'user-auth-flow')
    expect(loaded!.steps[0].status).toBe('completed')
    expect(loaded!.steps[0].files).toEqual(['src/a.ts', 'src/b.ts'])
    expect(loaded!.steps[1].status).toBe('in_progress')
  })
})
