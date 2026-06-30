### Task 11: PushProvider 接口 + DesktopNotificationProvider

**Files:**
- Create: `src/main/services/PushProvider.ts`
- Test: `src/tests/push-provider.test.ts`

**Interfaces:**
- Consumes: Electron `Notification` / `BrowserWindow`（运行期懒加载，测试期注入）。
- Produces（`src/main/services/PushProvider.ts`）：
  - `type PushStatus = 'info' | 'success' | 'warning' | 'error'`
  - `interface PushProvider { send(title: string, body: string, status: PushStatus): Promise<{ sent: boolean; note?: string }> }`
  - `class DesktopNotificationProvider implements PushProvider`：构造可选注入 `{ createNotification, focus }`（测试用）；默认走真实 Electron `Notification`，点击 `on('click')` → `BrowserWindow` focus。
  - `getPushProvider(): PushProvider` / `setPushProvider(p: PushProvider): void`（单例，供 PushNotification 工具与未来 RemoteControlProvider 注入）。
- 后续依赖：Task 12（PushNotification 工具）调 `getPushProvider().send(...)`。

**说明：** 远端通道（RemoteControlProvider）本期不实现，仅留接口位；未注入时恒走桌面。`sent:false` 视作预期（不支持/未发送），不重试。

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/push-provider.test.ts`
Expected: FAIL，`Cannot find module '../main/services/PushProvider'`。

- [ ] **Step 3: Write minimal implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/push-provider.test.ts`
Expected: PASS（4 例全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/main/services/PushProvider.ts src/tests/push-provider.test.ts
git commit -m "feat(services): add PushProvider interface + DesktopNotificationProvider"
```
