// src/main/services/PushProvider.ts
export type PushStatus = 'info' | 'success' | 'warning' | 'error'

export interface PushResult {
  sent: boolean
  note?: string
}

export interface PushProvider {
  send(title: string, body: string, status: PushStatus): Promise<PushResult>
}

export interface DesktopNotificationDeps {
  createNotification: (opts: { title: string; body: string }) => {
    show: () => void
    onClick?: (cb: () => void) => void
  }
  focus: () => void
}

export class DesktopNotificationProvider implements PushProvider {
  constructor(private deps?: DesktopNotificationDeps) {}

  async send(title: string, body: string, _status: PushStatus): Promise<PushResult> {
    if (this.deps) {
      const n = this.deps.createNotification({ title, body })
      n.onClick?.(() => this.deps!.focus())
      n.show()
      return { sent: true }
    }
    // 真实 Electron 路径（运行期）
    try {
      const { Notification, BrowserWindow } = require('electron')
      if (!Notification.isSupported()) return { sent: false, note: 'notifications not supported' }
      const n = new Notification({ title, body })
      n.on('click', () => {
        try {
          const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
          win?.focus?.()
        } catch {}
      })
      n.show()
      return { sent: true }
    } catch (e: any) {
      return { sent: false, note: e.message }
    }
  }
}

let provider: PushProvider | null = null

export function getPushProvider(): PushProvider {
  if (!provider) provider = new DesktopNotificationProvider()
  return provider
}

export function setPushProvider(p: PushProvider): void {
  provider = p
}
