// src/tests/skill-tool.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { SkillTool } from '../main/tools/builtin/SkillTool'
import { SkillManager } from '../main/services/SkillManager'

let root: string
const SKILL_NAME = 'My Test Skill'

async function setup(): Promise<string> {
  root = path.join(os.tmpdir(), `codez-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const dir = path.join(root, '.skills', 'MyTestSkill')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'),
    `---\nname: ${SKILL_NAME}\ndescription: a test skill\ntriggers: [test-skill]\n---\nThis is the skill body. Follow these instructions.`)
  return root
}

describe('SkillTool', () => {
  beforeEach(async () => { root = await setup() })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

  it('命中 skill：返回正文', async () => {
    const tool = new SkillTool()
    const result = await tool.execute(JSON.stringify({ skill: SKILL_NAME }), { workspaceRoot: root })
    expect(result).toContain('This is the skill body.')
  })

  it('未命中：返 Error 并列出可用清单', async () => {
    const tool = new SkillTool()
    const result = await tool.execute(JSON.stringify({ skill: 'no-such-skill' }), { workspaceRoot: root })
    expect(result.startsWith('Error:')).toBe(true)
    expect(result).toContain('not found')
    expect(result).toContain(SKILL_NAME)
  })

  it('缺 skill：返 Error', async () => {
    const tool = new SkillTool()
    const result = await tool.execute(JSON.stringify({}), { workspaceRoot: root })
    expect(result.startsWith('Error:')).toBe(true)
  })

  it('SkillManager.getSkillContent 命中返回 content，未命中返回 null', async () => {
    const sm = SkillManager.getInstance()
    expect(await sm.getSkillContent(root, SKILL_NAME)).toContain('This is the skill body.')
    expect(await sm.getSkillContent(root, 'no-such')).toBeNull()
  })
})
