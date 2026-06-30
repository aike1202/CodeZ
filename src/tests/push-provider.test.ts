// src/tests/push-provider.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { DesktopNotificationProvider, getPushProvider, setPushProvider, type PushProvider } from '../main/services/PushProvider'

describe('DesktopNotificationProvider', () => {
  it('send：调用 createNotification + show，返回 sent:true', async () => {
    const shown: any[] = []
    const provider = new DesktopNotificationProvider({
      createNotification: (opts) => {
        shown.push(opts)
        return { show: () => {}, onClick: () => {} }
      },
      focus: () => {}
    })
    const result = await provider.send('Title', 'body text', 'success')
    expect(result.sent).toBe(true)
    expect(shown[0].title).toBe('Title')
    expect(shown[0].body).toBe('body text')
  })

  it('click 回调触发 focus', async () => {
    let focused = false
    let clickCb: (() => void) | null = null
    const provider = new DesktopNotificationProvider({
      createNotification: () => ({ show: () => {}, onClick: (cb: () => void) => { clickCb = cb } }),
      focus: () => { focused = true }
    })
    await provider.send('T', 'b', 'info')
    expect(clickCb).not.toBeNull()
    clickCb!()
    expect(focused).toBe(true)
  })

  it('status 映射不影响 sent（仅作 title/图标提示）', async () => {
    const provider = new DesktopNotificationProvider({
      createNotification: () => ({ show: () => {}, onClick: () => {} }),
      focus: () => {}
    })
    for (const s of ['info', 'success', 'warning', 'error'] as const) {
      const r = await provider.send('T', 'b', s)
      expect(r.sent).toBe(true)
    }
  })
})

describe('PushProvider singleton', () => {
  beforeEach(() => { setPushProvider(new DesktopNotificationProvider({ createNotification: () => ({ show: () => {} }), focus: () => {} })) })

  it('getPushProvider 返回当前实例，setPushProvider 可替换', () => {
    const fake: PushProvider = { send: async () => ({ sent: false, note: 'fake' }) }
    setPushProvider(fake)
    expect(getPushProvider()).toBe(fake)
  })
})
