import type { CommandAction, CommandRisk, CommandRuleOption } from './commandAnalysisTypes'

export function createCommandRuleOptions(
  command: string,
  risk: CommandRisk,
  action: CommandAction,
  includeBroadRules: boolean
): CommandRuleOption[] {
  const parts = command.split(/\s+/).filter(Boolean)
  const options: CommandRuleOption[] = [
    { id: 'exact', label: '仅此完整命令', rule: command, description: '只允许当前这条完整命令。' }
  ]

  if (!includeBroadRules || parts.length === 0 || risk === 'destructive' || risk === 'unknown') {
    return options
  }

  const first = parts[0]
  const second = parts[1]
  const lowerFirst = first.toLowerCase()
  const lowerSecond = second?.toLowerCase()

  if (action === 'read' && lowerFirst === 'git') {
    options.push({ id: 'git-read', label: 'Git 只读命令', rule: `${first} ${second || 'status'} *`, description: '仅允许同类 Git 查询命令，不能覆盖写入或强制操作。' })
  } else if (action === 'read') {
    options.push({ id: 'safe-read', label: '同类只读命令', rule: `${first} *`, description: '仅允许 CommandAnalyzer 仍判定为只读的同类命令。' })
  } else if (action === 'network' && second && ['npm', 'yarn', 'pnpm', 'pip'].includes(lowerFirst)) {
    options.push({ id: 'package-manager', label: '同类安装命令', rule: `${first} ${second} *`, description: '允许同类依赖安装命令，但不会覆盖命令链或删除操作。' })
  } else if (action === 'network') {
    options.push({ id: 'network-command', label: '同类联网命令', rule: `${first} *`, description: '允许同类联网命令，但仍受风险上限约束。' })
  } else if (action === 'git' && second) {
    options.push({ id: 'git-write', label: '同类 Git 命令', rule: `${first} ${second} *`, description: '允许同类 Git 修改命令，不会覆盖 reset --hard 或 force push。' })
  } else if (risk === 'write' && second && ['run'].includes(lowerSecond)) {
    options.push({ id: 'runner', label: '同类脚本命令', rule: `${first} ${second} *`, description: '允许同类脚本执行命令，高风险组合仍需再次审核。' })
  }

  return options
}
