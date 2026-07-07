export function riskLabel(risk: string): string {
  switch (risk) {
    case 'safe': return '安全'
    case 'write': return '写入'
    case 'network': return '网络'
    case 'destructive': return '高风险'
    default: return '未知'
  }
}

export function actionLabel(action?: string): string {
  switch (action) {
    case 'read': return '只读'
    case 'modify': return '修改'
    case 'delete': return '删除'
    case 'network': return '联网'
    case 'git': return 'Git'
    case 'service': return '服务'
    default: return '未知'
  }
}
