### Task 12: PushNotification 工具（<200 字、status、{sent} 回灌）

**Files:**
- Create: `src/main/tools/builtin/PushNotificationTool.ts`
- Test: `src/tests/push-notification-tool.test.ts`

**Interfaces:**
- Consumes: `getPushProvider`/`setPushProvider`/`PushStatus`（Task 11）；`Tool`/`ToolContext`。
- Produces: `class PushNotificationTool extends Tool`，`name='PushNotification'`，`parameters_schema={message(req), status?('info'|'success'|'warning'|'error')}`。返回 JSON `{sent:boolean, note?:string}` 字符串；`sent:false` 时附 `note` 提示"无需重试"。`message` 缺失返 `Error: ...`。
- title 由 status 映射：`info→'Info'`、`success→'Success'`、`warning→'Warning'`、`error→'Error'`。

**说明：** `<200 字`约束写在 description 提示模型，execute 内不做强制裁剪（对齐 §11）。`status:'proactive'` 不在枚举内（官方有 `status:"proactive"`，本期收窄为四态）。

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/push-notification-tool.test.ts`
Expected: FAIL，`Cannot find module '../main/tools/builtin/PushNotificationTool'`。

- [ ] **Step 3: Write minimal implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/push-notification-tool.test.ts`
Expected: PASS（4 例全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/builtin/PushNotificationTool.ts src/tests/push-notification-tool.test.ts
git commit -m "feat(tools): add PushNotification tool (sent backfill, <200 char guidance)"
```
