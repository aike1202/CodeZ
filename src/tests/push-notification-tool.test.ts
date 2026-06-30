// src/tests/push-notification-tool.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { PushNotificationTool } from '../main/tools/builtin/PushNotificationTool'
import { setPushProvider, type PushProvider, type PushResult } from '../main/services/PushProvider'

function fakeProvider(result: PushResult): PushProvider {
  return {
    send: async (_title, _body, _status) => result
  }
}

describe('PushNotificationTool', () => {
  beforeEach(() => {
    setPushProvider(fakeProvider({ sent: true }))
  })

  it('成功发送：返回 sent:true', async () => {
    const tool = new PushNotificationTool()
    const result = await tool.execute(JSON.stringify({ message: 'build failed: 2 auth tests', status: 'error' }), { workspaceRoot: '.' })
    const parsed = JSON.parse(result)
    expect(parsed.sent).toBe(true)
  })

  it('未发送（sent:false）：返回 note，提示无需重试', async () => {
    setPushProvider(fakeProvider({ sent: false, note: 'notifications not supported' }))
    const tool = new PushNotificationTool()
    const result = await tool.execute(JSON.stringify({ message: 'hi', status: 'info' }), { workspaceRoot: '.' })
    const parsed = JSON.parse(result)
    expect(parsed.sent).toBe(false)
    expect(parsed.note).toBeTruthy()
  })

  it('status 缺省为 info', async () => {
    let captured: any = null
    setPushProvider({ send: async (t, b, s) => { captured = { t, b, s }; return { sent: true } } })
    const tool = new PushNotificationTool()
    await tool.execute(JSON.stringify({ message: 'done' }), { workspaceRoot: '.' })
    expect(captured.s).toBe('info')
    expect(captured.b).toBe('done')
  })

  it('缺 message：返 Error', async () => {
    const tool = new PushNotificationTool()
    const result = await tool.execute(JSON.stringify({}), { workspaceRoot: '.' })
    expect(result.startsWith('Error:')).toBe(true)
  })
})
