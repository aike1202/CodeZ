import { Tool, type ToolContext } from '../Tool'
import { getAgentCollaborationRuntime } from '../../services/agents'

function parseArgs(args: string): Record<string, any> {
  const value = JSON.parse(args || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be an object.')
  }
  return value
}

function requireSession(context: ToolContext): string {
  if (!context.sessionId) throw new Error('Agent collaboration requires a session ID.')
  return context.sessionId
}

export class SendMessageTool extends Tool {
  get name() { return 'send_message' }
  get summary() { return 'Send a message to an existing Agent.' }
  get description() {
    return 'Deliver a Markdown message to a running Agent or queue it for its next turn. This does not start an idle Agent.'
  }
  get parameters_schema() {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: 'Agent ID, canonical path, or /root.' },
        message: { type: 'string', description: 'Markdown message payload.' }
      },
      required: ['target', 'message']
    }
  }
  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = parseArgs(args)
      const message = await getAgentCollaborationRuntime().sendMessage({
        sessionId: requireSession(context),
        senderContextScopeId: context.contextScopeId,
        target: String(parsed.target || ''),
        message: String(parsed.message || '')
      })
      return JSON.stringify({ ok: true, data: { message_id: message.id, recipient: message.recipient } })
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export class ListAgentsTool extends Tool {
  get name() { return 'list_agents' }
  get summary() { return 'List addressable Agents and their current status.' }
  get description() { return 'List all SubAgents in the current session, including completed Agent threads.' }
  get parameters_schema() {
    return { type: 'object', additionalProperties: false, properties: {} }
  }
  async execute(_args: string, context: ToolContext): Promise<string> {
    try {
      const agents = getAgentCollaborationRuntime().list(requireSession(context)).map((agent) => ({
        agent_id: agent.id,
        path: agent.path,
        type: agent.type,
        status: agent.status,
        description: agent.description,
        run_count: agent.runCount,
        conclusion: agent.result?.conclusion
      }))
      return JSON.stringify({ ok: true, data: { agents } })
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export class WaitAgentTool extends Tool {
  get name() { return 'wait_agent' }
  get summary() { return 'Wait for one or more Agent mailbox updates.' }
  get description() {
    return 'Wait until a queued or running SubAgent sends MESSAGE or FINAL_ANSWER. Call this only while at least one selected Agent is queued/running. Do not call after receiving FINAL_ANSWER or when list_agents shows no active Agent. If no target is active, this returns immediately. The mailbox payload is injected into your next model turn.'
  }
  get parameters_schema() {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        targets: { type: 'array', items: { type: 'string' }, description: 'Optional Agent IDs or paths.' },
        timeout_ms: { type: 'number', minimum: 0, maximum: 60000, default: 30000 }
      }
    }
  }
  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = parseArgs(args)
      const sessionId = requireSession(context)
      const runtime = getAgentCollaborationRuntime()
      const recipient = runtime.pathForContext(sessionId, context.contextScopeId)
      const timeout = Math.max(0, Math.min(60000, Number(parsed.timeout_ms ?? 30000)))
      const result = await runtime.waitForUpdate(sessionId, recipient, timeout, parsed.targets)
      return JSON.stringify({
        ok: true,
        data: {
          updated: result.messages.length > 0,
          outcome: result.outcome,
          messages: result.messages.map((message) => ({
            message_id: message.id,
            type: message.type,
            author: message.author
          }))
        }
      })
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export class InterruptAgentTool extends Tool {
  get name() { return 'interrupt_agent' }
  get summary() { return 'Interrupt a running SubAgent.' }
  get description() { return 'Stop the current turn of a running SubAgent while retaining its durable identity and context.' }
  get parameters_schema() {
    return {
      type: 'object',
      additionalProperties: false,
      properties: { target: { type: 'string', description: 'Agent ID or canonical path.' } },
      required: ['target']
    }
  }
  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = parseArgs(args)
      const interrupted = getAgentCollaborationRuntime().interrupt(
        requireSession(context),
        String(parsed.target || '')
      )
      return JSON.stringify(interrupted
        ? { ok: true, data: { interrupted: true } }
        : { ok: false, error: 'Agent is not running or was not found.' })
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

