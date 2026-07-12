import { Tool, type ToolContext } from '../Tool'
import { getMcpConnectionManager } from '../../services/mcp'
import type { ToolExecutionResult } from '../runtime/types'

export class McpAuthTool extends Tool {
  get name() { return 'McpAuth' }
  get summary() { return 'Authenticate or log out an MCP server' }
  get description() { return 'Start OAuth authentication for a configured remote MCP server, or revoke/logout its credentials. This may open the system browser.' }
  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        server: { type: 'string', minLength: 1 },
        action: { type: 'string', enum: ['login', 'logout'] }
      },
      required: ['server', 'action'],
      additionalProperties: false
    }
  }
  async execute(args: string, _context: ToolContext): Promise<string> {
    const input = JSON.parse(args) as { server: string; action: 'login' | 'logout' }
    try {
      if (input.action === 'login') await getMcpConnectionManager().authorize(input.server)
      else await getMcpConnectionManager().logout(input.server)
      return JSON.stringify({ ok: true, data: { server: input.server, action: input.action } })
    } catch (error: any) {
      return JSON.stringify({ ok: false, error: error?.message || String(error) })
    }
  }

  async executeTyped(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const server = String(input.server)
    const action = input.action === 'logout' ? 'logout' : 'login'
    try {
      if (action === 'login') await getMcpConnectionManager().authorize(server)
      else await getMcpConnectionManager().logout(server)
      const data = { server, action }
      return { status: 'success', data, modelContent: JSON.stringify(data) }
    } catch (error: any) {
      return {
        status: 'error',
        error: { code: 'MCP_AUTH_FAILED', message: error?.message || String(error), recoverable: true }
      }
    }
  }
}
