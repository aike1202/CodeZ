import { describe, it, expect } from 'vitest'
import { parseSlashCommand } from '../renderer/src/commands/SlashCommandParser'
import type { SkillDefinition } from '../shared/types/skill'

const skill = (id: string, name: string): SkillDefinition => ({
  id,
  name,
  description: '',
  content: 'do stuff',
  enabled: true,
  isGlobal: true,
  builtin: true
})

describe('parseSlashCommand — 技能优先于 plan slug', () => {
  const skills = [
    skill('global-skill-creator', 'skill-creator'),
    skill('global-find-skills', 'find-skills'),
    skill('global-rule-creator', 'rule-creator')
  ]

  it('/skill-creator 被识别为技能而非 plan:load', () => {
    const r = parseSlashCommand('/skill-creator 帮我写一个技能：', skills)
    expect(r.clientAction).toBeUndefined()
    expect(r.isCommand).toBe(true)
    expect(r.processedMessage).toContain('skill-creator')
    expect(r.processedMessage).toContain('帮我写一个技能')
  })

  it('/rule-creator 被识别为技能', () => {
    const r = parseSlashCommand('/rule-creator 帮我写一条规则：', skills)
    expect(r.clientAction).toBeUndefined()
    expect(r.processedMessage).toContain('do stuff')
  })

  it('未注册的 kebab-case slug 仍走 plan:load', () => {
    const r = parseSlashCommand('/my-cool-plan', skills)
    expect(r.clientAction?.type).toBe('plan:load')
    expect(r.clientAction?.payload?.slug).toBe('my-cool-plan')
  })

  it('胶囊格式 [$skill-creator](path) 被识别为技能', () => {
    const r = parseSlashCommand('[$skill-creator](skill-creator) 帮我写一个技能：', skills)
    expect(r.clientAction).toBeUndefined()
    expect(r.isCommand).toBe(true)
    expect(r.processedMessage).toContain('do stuff')
    expect(r.processedMessage).toContain('帮我写一个技能')
  })

  it('/compact 被识别为本地压缩动作', () => {
    expect(parseSlashCommand('/compact 保留迁移决定', skills)).toEqual({
      isCommand: true,
      commandName: 'compact',
      processedMessage: '',
      clientAction: { type: 'context:compact', payload: { instructions: '保留迁移决定' } }
    })
  })
})
