import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { SkillManager } from '../main/services/SkillManager'

let home: string

// SkillManager 内部用 os.homedir() 定位 ~/.codez；用可变闭包变量指向每个用例的临时目录。
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    default: { ...actual, homedir: () => home },
    homedir: () => home
  }
})

async function writeSkill(dir: string, name: string): Promise<void> {
  const skillDir = path.join(dir, name)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test ${name}\n---\nbody`,
    'utf-8'
  )
}

describe('SkillManager builtin', () => {
  beforeEach(() => {
    home = path.join(os.tmpdir(), `codez-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    // 隔离测试：不触发真实内置资源同步
    process.env.CODEZ_BUILTIN_SKILLS_DIR = path.join(home, 'no-such-dir')
    // 重置单例
    ;(SkillManager as any)['instance'] = undefined
  })
  afterEach(async () => {
    delete process.env.CODEZ_BUILTIN_SKILLS_DIR
    await fs.rm(home, { recursive: true, force: true })
  })

  it('全局技能中命中内置名的被标记 builtin，其余为 false', async () => {
    const globalDir = path.join(home, '.codez', 'skills')
    await writeSkill(globalDir, 'skill-creator')
    await writeSkill(globalDir, 'my-custom')

    const sm = SkillManager.getInstance()
    const skills = await sm.scanWorkspace(null)

    const creator = skills.find((s) => s.id === 'global-skill-creator')
    const custom = skills.find((s) => s.id === 'global-my-custom')
    expect(creator?.builtin).toBe(true)
    expect(custom?.builtin).toBe(false)
  })

  it('deleteSkill 拒绝删除内置技能', async () => {
    const globalDir = path.join(home, '.codez', 'skills')
    await writeSkill(globalDir, 'skill-creator')

    const sm = SkillManager.getInstance()
    await sm.scanWorkspace(null)
    const ok = await sm.deleteSkill(null, 'global-skill-creator')
    expect(ok).toBe(false)

    // 目录仍存在
    const stat = await fs.stat(path.join(globalDir, 'skill-creator'))
    expect(stat.isDirectory()).toBe(true)
  })
})
