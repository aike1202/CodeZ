import type { McpServerConfig, McpServerStatus, ScopedMcpConfig } from './types'

export const MCP_STATE_LABELS: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  'needs-auth': '需要认证',
  failed: '连接失败',
  disabled: '已停用',
  stopped: '已停止',
  'trust-required': '等待信任'
}

export const MCP_SCOPE_LABELS: Record<ScopedMcpConfig['scope'], string> = {
  user: '用户配置',
  project: '项目配置',
  local: '本地配置',
  dynamic: '动态配置',
  managed: '托管配置'
}

export function stateLabel(state?: string): string {
  return MCP_STATE_LABELS[state || 'stopped'] || state || '已停止'
}

export function serverDescription(config: ScopedMcpConfig, status?: McpServerStatus): string {
  if (config.config.description?.trim()) return config.config.description.trim()
  const title = status?.serverInfo?.title?.trim()
  if (title && title !== config.name) return title
  if (config.config.type === 'stdio') {
    const packageName = config.config.args?.find((argument) => !argument.startsWith('-'))
    return packageName ? `${config.config.command || 'stdio'} · ${packageName}` : `本地进程 · ${config.config.command || '未配置命令'}`
  }
  try {
    return `远程服务 · ${new URL(config.config.url || '').host}`
  } catch {
    return '远程 MCP 服务'
  }
}

export function serializeUserConfiguration(configs: ScopedMcpConfig[]): string {
  const entries = configs
    .filter((config) => config.scope === 'user')
    .map((config) => [config.name, config.config] as const)
  return JSON.stringify({ mcpServers: Object.fromEntries(entries) }, null, 2)
}

export function parseUserConfiguration(source: string): Record<string, McpServerConfig> {
  const parsed = JSON.parse(source) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP 配置必须是一个 JSON 对象。')
  }
  const root = parsed as Record<string, unknown>
  const rawServers = root.mcpServers ?? root.servers ?? root
  if (!rawServers || typeof rawServers !== 'object' || Array.isArray(rawServers)) {
    throw new Error('mcpServers 必须是一个对象。')
  }
  const servers = rawServers as Record<string, unknown>
  for (const [name, config] of Object.entries(servers)) {
    if (!name.trim()) throw new Error('MCP Server 名称不能为空。')
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`${name}: 配置必须是一个对象。`)
    }
  }
  return servers as Record<string, McpServerConfig>
}

export function configEndpoint(config: McpServerConfig): string {
  if (config.type === 'stdio') return [config.command, ...(config.args || [])].filter(Boolean).join(' ')
  return config.url || '未配置 URL'
}
