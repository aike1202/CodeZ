export const permissionLabels: Record<string, string> = {
  'ask': '请求批准',
  'auto-approve-safe': '替我审批',
  'full-access': '完全访问'
}

export const PERMISSION_MODES = [
  {
    id: 'ask',
    title: '请求批准',
    subtitle: '每次执行系统命令或写入文件时都会询问。推荐新手使用。'
  },
  {
    id: 'auto-approve-safe',
    title: '替我审批',
    subtitle: '自动放行安全操作，仅拦截修改与风险命令。'
  },
  {
    id: 'full-access',
    title: '完全访问',
    subtitle: '减少确认次数。赋予极高权限，仅拦截极端危险命令。'
  }
]
