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
    name: 'rule',
    aliases: ['memory'],
    description: '使用工具更新项目的规则与记忆',
    process: (args: string) => {
      const rest = args.trim()
      return `[用户调用了 /rule 快捷指令]\n要求内容：${rest || '(未提供详细内容，请询问我需要添加或修改什么规则)'}\n\n【系统强制指令】：你必须作为项目记忆管理员，立即调用文件读写工具（如 ReplaceFileContentTool, WriteToFileTool 等），在当前工作空间的 \`.agent/rules/\` 目录下更新或新建 Markdown 约束文件，以持久化记录此规则或记忆。请务必使用工具操作文件，不要仅仅用纯文本回复！操作成功后，向用户简短汇报变更情况。`
    }
  }
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
