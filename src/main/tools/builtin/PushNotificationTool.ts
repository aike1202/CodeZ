// src/main/tools/builtin/PushNotificationTool.ts
import { Tool, ToolContext } from '../Tool'
import { getPushProvider, type PushStatus } from '../../services/PushProvider'

interface PushArgs {
  message?: string
  status?: PushStatus
}

const STATUS_TITLE: Record<PushStatus, string> = {
  info: 'Info',
  success: 'Success',
  warning: 'Warning',
  error: 'Error'
}

export class PushNotificationTool extends Tool {
  get name() {
    return 'PushNotification'
  }

  get description() {
    return 'Sends a desktop notification. Use sparingly — do NOT notify for routine progress, for things asked seconds ago, or when a quick task completes. Notify only when the user may have walked away and something is worth coming back for, or when explicitly asked. Keep the message under 200 characters, one line, no markdown. Lead with what they would act on (e.g. "build failed: 2 auth tests"). status: info/success/warning/error. If the result says sent:false, that is expected — do not retry.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Notification body, under 200 chars, one line, no markdown.' },
        status: { type: 'string', enum: ['info', 'success', 'warning', 'error'], description: 'Default info.' }
      },
      required: ['message']
    }
  }

  async execute(args: string, _context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as PushArgs
      if (!parsed.message) return 'Error: message is required.'
      const status: PushStatus = parsed.status || 'info'
      const title = STATUS_TITLE[status] || 'Info'
      const result = await getPushProvider().send(title, parsed.message, status)
      return JSON.stringify(result)
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }
}
