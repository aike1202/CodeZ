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
  // 未来可以在此处轻松扩展更多的 Slash Commands，比如 /skill, /mcp 等
]

export function parseSlashCommand(message: string): { isCommand: boolean; processedMessage: string; commandName?: string } {
  if (!message.trim().startsWith('/')) {
    return { isCommand: false, processedMessage: message }
  }

  const parts = message.trim().split(/\s+/)
  const cmdName = parts[0].substring(1).toLowerCase()
  const args = parts.slice(1).join(' ')

  const command = builtinCommands.find((c) => c.name === cmdName || c.aliases?.includes(cmdName))

  if (command) {
    return {
      isCommand: true,
      commandName: cmdName,
      processedMessage: command.process(args)
    }
  }

  // 若遇到未注册的命令，可直接返回原样，让后端 LLM 自己理解，或者预留给后续的动态 Skills/MCP
  return { isCommand: false, processedMessage: message }
}
