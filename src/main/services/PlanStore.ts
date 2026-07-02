import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createHash } from 'crypto'
import { BrowserWindow } from 'electron'
import matter from 'gray-matter'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import type { Plan, PlanStep } from '../../shared/types/plan'

/**
 * Plan 持久化服务。
 *
 * Plan 以 Markdown + YAML frontmatter 形式存储：
 *   ~/.codez/projects/<md5(workspace)>/plans/<slug>.md
 *
 * frontmatter 保存元数据（id/slug/title/status/...），
 * body 保存步骤详情（## P0 ... ## P1 ...）。
 */
export class PlanStore {
  /**
   * 计算 workspace 对应的 plans 目录路径。
   */
  static getPlansDir(workspaceRoot: string): string {
    const hash = createHash('md5').update(path.resolve(workspaceRoot)).digest('hex')
    return path.join(os.homedir(), '.codez', 'projects', hash, 'plans')
  }

  /** 实例方法包装，便于测试 mock */
  getPlansDir(workspaceRoot: string): string {
    return PlanStore.getPlansDir(workspaceRoot)
  }

  /**
   * 列出 workspace 的所有 Plan。
   */
  async list(workspaceRoot: string): Promise<Plan[]> {
    const dir = this.getPlansDir(workspaceRoot)
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return []
    }
    const plans: Plan[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue
      const filePath = path.join(dir, entry)
      const plan = await this.readPlanFile(filePath)
      if (plan) plans.push(plan)
    }
    return plans
  }

  /**
   * 按 slug 读取单个 Plan。
   */
  async getBySlug(workspaceRoot: string, slug: string): Promise<Plan | null> {
    const filePath = path.join(this.getPlansDir(workspaceRoot), `${slug}.md`)
    return this.readPlanFile(filePath)
  }

  /**
   * 保存 Plan（upsert by slug）。
   */
  async save(workspaceRoot: string, plan: Plan): Promise<void> {
    const dir = this.getPlansDir(workspaceRoot)
    await fs.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, `${plan.slug}.md`)
    const content = this.serialize(plan)
    await fs.writeFile(filePath, content, 'utf-8')

    // 广播状态更新
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(IPC_CHANNELS.PLAN_STATE_CHANGED, plan)
    })
  }

  /**
   * 删除 Plan。
   */
  async delete(workspaceRoot: string, slug: string): Promise<void> {
    const filePath = path.join(this.getPlansDir(workspaceRoot), `${slug}.md`)
    try {
      await fs.unlink(filePath)
    } catch {
      // ignore
    }
  }

  /**
   * 返回当前唯一的 executing Plan（若无则 null）。
   */
  async getActive(workspaceRoot: string): Promise<Plan | null> {
    const plans = await this.list(workspaceRoot)
    return plans.find(p => p.status === 'executing') || null
  }

  /**
   * 将目标 Plan 设为 executing，其他 executing 的改为 suspended。
   */
  async setActive(workspaceRoot: string, slug: string): Promise<void> {
    const plans = await this.list(workspaceRoot)
    for (const plan of plans) {
      if (plan.slug === slug) {
        plan.status = 'executing'
        plan.updatedAt = new Date().toISOString()
        await this.save(workspaceRoot, plan)
      } else if (plan.status === 'executing') {
        plan.status = 'suspended'
        plan.suspendedReason = 'superseded by another active plan'
        plan.updatedAt = new Date().toISOString()
        await this.save(workspaceRoot, plan)
      }
    }
  }

  // ─── 序列化 / 反序列化 ──────────────────────────────────────────

  /**
   * 将 Plan 序列化为 frontmatter + markdown body。
   */
  private serialize(plan: Plan): string {
    const { steps, ...meta } = plan
    // 剔除 undefined 字段，避免 YAML dump 错误
    const frontmatterObj: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(meta)) {
      if (v !== undefined) frontmatterObj[k] = v
    }

    const body = steps.map(step => {
      const lines = [`## ${step.id} ${step.title}`]
      lines.push(`- status: ${step.status}`)
      if (step.files && step.files.length > 0) {
        lines.push(`- files: ${step.files.join(', ')}`)
      }
      lines.push('')
      lines.push(step.description)
      return lines.join('\n')
    }).join('\n\n')

    // gray-matter 会把 steps 数组也写进 frontmatter，我们手动剔除后用 stringify
    const fm = matter.stringify(body, frontmatterObj)
    return fm
  }

  /**
   * 从文件读取并解析 Plan。
   */
  private async readPlanFile(filePath: string): Promise<Plan | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const parsed = matter(raw)
      const meta = parsed.data as Partial<Plan>
      const steps = this.parseSteps(parsed.content)
      return {
        id: meta.id || '',
        slug: meta.slug || path.basename(filePath, '.md'),
        title: meta.title || '',
        description: meta.description || '',
        projectId: meta.projectId || '',
        steps,
        status: meta.status || 'drafting',
        createdAt: meta.createdAt || new Date().toISOString(),
        updatedAt: meta.updatedAt || new Date().toISOString(),
        suspendedReason: meta.suspendedReason
      }
    } catch {
      return null
    }
  }

  /**
   * 从 markdown body 解析步骤列表。
   *
   * 格式：
   *   ## p0 搭建模型
   *   - status: pending
   *   - files: src/a.ts, src/b.ts
   *
   *   描述内容...
   */
  private parseSteps(body: string): PlanStep[] {
    const steps: PlanStep[] = []
    // 按 ## 标题分块
    const blocks = body.split(/^## /m).filter(b => b.trim())
    for (const block of blocks) {
      const lines = block.split('\n')
      const headerLine = lines[0] || ''
      // "p0 搭建模型" → id=p0, title=搭建模型
      const headerMatch = headerLine.match(/^(\S+)\s*(.*)$/)
      if (!headerMatch) continue
      const id = headerMatch[1]
      const title = headerMatch[2] || ''

      let status: PlanStep['status'] = 'pending'
      let files: string[] | undefined
      const descLines: string[] = []

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]
        const statusMatch = line.match(/^-\s*status:\s*(\w+)/)
        if (statusMatch) {
          status = statusMatch[1] as PlanStep['status']
          continue
        }
        const filesMatch = line.match(/^-\s*files:\s*(.+)/)
        if (filesMatch) {
          files = filesMatch[1].split(',').map(s => s.trim()).filter(Boolean)
          continue
        }
        descLines.push(line)
      }

      const description = descLines.join('\n').trim()
      steps.push({ id, title, description, status, ...(files ? { files } : {}) })
    }
    return steps
  }
}
