import type { SkillDefinition } from '@shared/types/skill'

export interface SlashCommand {
  name: string
  aliases?: string[]
  description: string
  /**
   * 将用户的原始输入转换为带有系统强制指令的 Prompt，引导 AI 完成对应任务
   */
  process: (args: string) => string
}

export interface ClientAction {
  type: string
  payload?: any
}

export interface ParseResult {
  isCommand: boolean
  processedMessage: string
  commandName?: string
  /** 客户端本地处理的动作，不需要发送给 AI */
  clientAction?: ClientAction
}

export const builtinCommands: SlashCommand[] = [
  {
    name: 'goal',
    description: '查看、设置、替换、暂停、恢复或清除当前会话目标。',
    process: (args) => `/goal ${args}`
  },
  {
    name: 'compact',
    description: '压缩当前对话，可附加摘要要求。',
    process: (args) => `/compact ${args}`
  }
]

export function parseSlashCommand(
  message: string,
  dynamicSkills: SkillDefinition[] = []
): ParseResult {
  const trimMsg = message.trim()

  // ── Plan commands: /plan, /plans, /plan list, /plan new <description> ──
  if (trimMsg === '/plan' || trimMsg === '/plans' || trimMsg.startsWith('/plan ')) {
    const rest = trimMsg.startsWith('/plans') ? trimMsg.slice(6).trim() : trimMsg.slice(5).trim() // after '/plan' or '/plans'
    if (!rest) {
      // /plan alone → show plan list modal
      return {
        isCommand: true,
        commandName: 'plan',
        processedMessage: '',
        clientAction: { type: 'plan:show-list' }
      }
    }
    if (rest === 'list') {
      // /plan list → show plan list modal
      return {
        isCommand: true,
        commandName: 'plan',
        processedMessage: '',
        clientAction: { type: 'plan:show-list' }
      }
    }
    if (rest.startsWith('new ') || rest.startsWith('new')) {
      const description = rest.startsWith('new ') ? rest.slice(4).trim() : rest.slice(3).trim()
      // /plan new <description> → toggle plan mode ON, send description as user message
      return {
        isCommand: true,
        commandName: 'plan',
        processedMessage: description || rest,
        clientAction: { type: 'plan:new', payload: { description: description || rest } }
      }
    }
  }

  // ── /<slug> plan loading ──
  // Match /<kebab-case> patterns that look like plan slugs
  if (trimMsg.startsWith('/')) {
    const parts = trimMsg.split(/\s+/)
    const potentialSlug = parts[0].substring(1) // remove leading '/'
    // A slug-like pattern: only lowercase, digits, hyphens
    const slugPattern = /^[a-z][a-z0-9-]*$/
    if (slugPattern.test(potentialSlug)) {
      // 先排除已注册的内置命令与技能：它们虽是 kebab-case，但不是 plan slug
      const slugLower = potentialSlug.toLowerCase()
      const isBuiltinCommand = builtinCommands.some(
        (c) => c.name === slugLower || c.aliases?.includes(slugLower)
      )
      const isSkill = dynamicSkills.some(
        (s) =>
          s.id.toLowerCase() === slugLower ||
          s.id.replace(/^(global|workspace|builtin)-/, '').toLowerCase() === slugLower ||
          s.triggers?.includes(slugLower)
      )
      if (!isBuiltinCommand && !isSkill) {
        return {
          isCommand: true,
          commandName: potentialSlug,
          processedMessage: '',
          clientAction: { type: 'plan:load', payload: { slug: potentialSlug } }
        }
      }
    }
  }

  let cmdName = ''
  let args = ''
  let found = false

  // 1. Check for standard /command
  if (trimMsg.startsWith('/')) {
    const parts = trimMsg.split(/\s+/)
    cmdName = parts[0].substring(1).toLowerCase()
    args = parts.slice(1).join(' ')
    found = true
  }
  // 2. Check for UI pill format: [$skillName](path)
  else if (trimMsg.startsWith('[$')) {
    const match = trimMsg.match(/^\[\$([^\]]+)\]\([^)]+\)/)
    if (match) {
      cmdName = match[1].toLowerCase()
      args = trimMsg.substring(match[0].length).trim()
      found = true
    }
  }

  if (!found) {
    return { isCommand: false, processedMessage: message }
  }

  const command = builtinCommands.find((c) => c.name === cmdName || c.aliases?.includes(cmdName))

  if (command) {
    return {
      isCommand: true,
      commandName: cmdName,
      processedMessage: command.process(args)
    }
  }

  const skill = dynamicSkills.find(s =>
    s.id.toLowerCase() === cmdName ||
    s.id.replace(/^(global|workspace|builtin)-/, '').toLowerCase() === cmdName ||
    s.triggers?.includes(cmdName)
  )
  if (skill) {
    return {
      isCommand: true,
      commandName: cmdName,
      processedMessage: `【本次请求强制应用工作流：${skill.name}】\n\n指令要求如下：\n${skill.content}\n\n当前任务参数/问题：\n${args}`
    }
  }

  // 若遇到未注册的命令，可直接返回原样，让后端 LLM 自己理解，或者预留给后续的动态 Skills/MCP
  return { isCommand: false, processedMessage: message }
}
