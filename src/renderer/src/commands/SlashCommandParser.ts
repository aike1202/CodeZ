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
): { isCommand: boolean; processedMessage: string; commandName?: string } {
  let cmdName = ''
  let args = ''
  let found = false

  const trimMsg = message.trim()

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
    s.id.replace(/^(global|workspace)-/, '').toLowerCase() === cmdName ||
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
