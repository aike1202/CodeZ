import { createHash } from 'crypto'

function sanitizeMcpName(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'server'
}

export function normalizeMcpName(value: string): string {
  return sanitizeMcpName(value).slice(0, 48)
}

export function mcpToolName(serverName: string, toolName: string): string {
  const fullName = `mcp__${normalizeMcpName(serverName)}__${sanitizeMcpName(toolName)}`
  if (fullName.length <= 64) return fullName
  const suffix = createHash('sha256')
    .update(`${serverName}\0${toolName}`)
    .digest('hex')
    .slice(0, 8)
  return `${fullName.slice(0, 55)}_${suffix}`
}
