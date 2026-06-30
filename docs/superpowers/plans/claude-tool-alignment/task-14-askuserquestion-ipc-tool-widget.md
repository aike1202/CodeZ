### Task 14: AskUserQuestion（IPC + preload + 渲染端 Widget + 工具 + AgentRunner 拦截）

**Files:**
- Create: `src/main/tools/builtin/AskUserQuestionTool.ts`
- Modify: `src/shared/ipc/channels.ts`（加 `CHAT_REQUEST_ASK_USER` / `CHAT_ASK_USER_RESPONSE`）
- Modify: `src/main/agent/AgentRunner.ts`（callbacks 加 `onAskUserRequest`；派发循环插入拦截）
- Modify: `src/main/ipc/chat.handlers.ts`（`runner.run` 回调加 `onAskUserRequest`）
- Modify: `src/preload/index.ts`（加 `chat.respondAskUser` + `onAskUserRequest` 转发 + cleanup）
- Modify: `src/renderer/src/env.d.ts`（chat 类型加 `respondAskUser` 与 `onAskUserRequest`）
- Modify: `src/renderer/src/stores/chatStore.ts`（加 `AskUserRequestState` + `addAskUserRequest`/`resolveAskUserRequest`）
- Modify: `src/renderer/src/components/chat/hooks/useSendMessage.ts`（`onAskUserRequest` 回调）
- Create: `src/renderer/src/components/chat/AskUserQuestionWidget.tsx` + `.css`
- Modify: `src/renderer/src/components/chat/ChatArea.tsx`（auditArea 渲染 Widget）
- Test: `src/tests/ask-user-question-tool.test.ts`

**Interfaces:**
- Consumes: `Tool`/`ToolContext`；IPC `CHAT_REQUEST_APPROVAL` 范式（`chat.handlers.ts:172-180`、`preload/index.ts:109-136`）。
- Produces（`AskUserQuestionTool.ts`）：
  - `interface AskUserOption { label:string; description?:string; preview?:string }`
  - `interface AskUserQuestionItem { question:string; header:string; options:AskUserOption[]; multiSelect?:boolean }`
  - `interface AskUserRequest { id:string; questions:AskUserQuestionItem[] }`
  - `interface AskUserAnswer { question:string; answer:string|string[] }`
  - `validateAskUserRequest(parsed): {ok:true; questions} | {ok:false; error}`
  - `interceptAskUser(name, parsedArgs, id, handler): Promise<{handled:boolean; result?:string; isError?:boolean}>`
  - `class AskUserQuestionTool extends Tool`，`name='AskUserQuestion'`。
- 派发：AgentRunner 在权限检查之后、`toolInstance.execute` 之前调用 `interceptAskUser`；命中即用其 `result` 作为 `resultMessage`（不调 execute）。`onAskUserRequest` 经 `chat.handlers` → IPC → 渲染端 Widget → `respondAskUser` 回灌。

**说明：** PermissionManager 将 `AskUserQuestion`→`allow`（Task 15），避免触发通用 permission 卡片；AgentRunner 拦截后专门起 AskUser UI。`>4 问题`或每问 `options` 非 2–4 → `interceptAskUser` 直接返错。计划模式本期未启用，文案保留，行为等同普通提问。

- [ ] **Step 1: Write the failing test**

```ts
// src/tests/ask-user-question-tool.test.ts
import { describe, it, expect } from 'vitest'
import { validateAskUserRequest, interceptAskUser, AskUserQuestionTool } from '../main/tools/builtin/AskUserQuestionTool'

const validArgs = {
  questions: [{
    question: 'Which lib?', header: 'Lib',
    options: [{ label: 'A' }, { label: 'B' }]
  }]
}

describe('validateAskUserRequest', () => {
  it('1 问 2 选项：ok', () => {
    expect(validateAskUserRequest(validArgs).ok).toBe(true)
  })
  it('5 问：error', () => {
    const qs = Array.from({ length: 5 }, () => ({ question: 'q', header: 'h', options: [{ label: 'a' }, { label: 'b' }] }))
    expect(validateAskUserRequest({ questions: qs }).ok).toBe(false)
  })
  it('0 问：error', () => {
    expect(validateAskUserRequest({ questions: [] }).ok).toBe(false)
  })
  it('options <2：error', () => {
    expect(validateAskUserRequest({ questions: [{ question: 'q', header: 'h', options: [{ label: 'a' }] }] }).ok).toBe(false)
  })
  it('options >4：error', () => {
    const opts = Array.from({ length: 5 }, (_, i) => ({ label: String(i) }))
    expect(validateAskUserRequest({ questions: [{ question: 'q', header: 'h', options: opts }] }).ok).toBe(false)
  })
  it('缺 question：error', () => {
    expect(validateAskUserRequest({ questions: [{ header: 'h', options: [{ label: 'a' }, { label: 'b' }] }] }).ok).toBe(false)
  })
})

describe('interceptAskUser', () => {
  it('非 AskUserQuestion：handled:false', async () => {
    const r = await interceptAskUser('Read', {}, 'id1', async () => [])
    expect(r.handled).toBe(false)
  })
  it('合法 + handler：返回 answers JSON，isError false', async () => {
    const r = await interceptAskUser('AskUserQuestion', validArgs, 'id1', async () => [{ question: 'Which lib?', answer: 'A' }])
    expect(r.handled).toBe(true)
    expect(r.isError).toBeFalsy()
    const parsed = JSON.parse(r.result!)
    expect(parsed[0].answer).toBe('A')
  })
  it('合法 + 无 handler：error', async () => {
    const r = await interceptAskUser('AskUserQuestion', validArgs, 'id1', null)
    expect(r.handled).toBe(true)
    expect(r.result).toContain('Error:')
  })
  it('非法：error', async () => {
    const r = await interceptAskUser('AskUserQuestion', { questions: [] }, 'id1', async () => [])
    expect(r.result).toContain('Error:')
  })
})

describe('AskUserQuestionTool.execute (直接调用做校验)', () => {
  it('合法：返回 questions 请求载荷', async () => {
    const tool = new AskUserQuestionTool()
    const r = await tool.execute(JSON.stringify(validArgs), { workspaceRoot: '.' })
    const parsed = JSON.parse(r)
    expect(parsed.questions[0].question).toBe('Which lib?')
  })
  it('非法：Error', async () => {
    const tool = new AskUserQuestionTool()
    const r = await tool.execute(JSON.stringify({ questions: [] }), { workspaceRoot: '.' })
    expect(r.startsWith('Error:')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/ask-user-question-tool.test.ts`
Expected: FAIL，`Cannot find module '../main/tools/builtin/AskUserQuestionTool'`。

- [ ] **Step 3: Write AskUserQuestionTool + validators**

```ts
// src/main/tools/builtin/AskUserQuestionTool.ts
import { Tool, ToolContext } from '../Tool'

export interface AskUserOption {
  label: string
  description?: string
  preview?: string
}
export interface AskUserQuestionItem {
  question: string
  header: string
  options: AskUserOption[]
  multiSelect?: boolean
}
export interface AskUserRequest {
  id: string
  questions: AskUserQuestionItem[]
}
export interface AskUserAnswer {
  question: string
  answer: string | string[]
}

export type AskUserHandler = (req: AskUserRequest) => Promise<AskUserAnswer[]>

export function validateAskUserRequest(parsed: any): { ok: true; questions: AskUserQuestionItem[] } | { ok: false; error: string } {
  const qs = parsed?.questions
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 4) {
    return { ok: false, error: 'questions must be an array of 1-4 items.' }
  }
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i]
    if (!q || typeof q.question !== 'string' || !q.question) {
      return { ok: false, error: `questions[${i}].question is required.` }
    }
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
      return { ok: false, error: `questions[${i}].options must have 2-4 items.` }
    }
  }
  return { ok: true, questions: qs as AskUserQuestionItem[] }
}

export async function interceptAskUser(
  name: string,
  parsedArgs: any,
  id: string,
  handler: AskUserHandler | null
): Promise<{ handled: boolean; result?: string; isError?: boolean }> {
  if (name !== 'AskUserQuestion') return { handled: false }
  const v = validateAskUserRequest(parsedArgs)
  if (!v.ok) return { handled: true, result: `Error: ${v.error}`, isError: true }
  if (!handler) return { handled: true, result: 'Error: No ask-user handler registered.', isError: true }
  try {
    const answers = await handler({ id, questions: v.questions })
    return { handled: true, result: JSON.stringify(answers) }
  } catch (e: any) {
    return { handled: true, result: `Error: ${e.message}`, isError: true }
  }
}

interface AskUserArgs {
  questions?: AskUserQuestionItem[]
}

export class AskUserQuestionTool extends Tool {
  get name() {
    return 'AskUserQuestion'
  }

  get description() {
    return 'Use only when blocked on a decision genuinely the user\'s to make (one you cannot resolve from the request/code/sensible defaults). Users can always select "Other" for custom input; multiSelect allows multiple answers. Put the recommended option first and suffix its label with "(Recommended)". Reserve for decisions where the answer changes what you do next. 1-4 questions, each with 2-4 options. preview (single-select only) shows an ASCII/code mockup side-by-side. Do NOT ask "Is my plan ready?" — this is not plan mode.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string', description: 'Very short label (max ~12 chars).' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                    preview: { type: 'string' }
                  },
                  required: ['label']
                }
              },
              multiSelect: { type: 'boolean' }
            },
            required: ['question', 'header', 'options']
          }
        }
      },
      required: ['questions']
    }
  }

  async execute(args: string, _context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as AskUserArgs
      const v = validateAskUserRequest(parsed)
      if (!v.ok) return `Error: ${v.error}`
      return JSON.stringify({ questions: v.questions })
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }
}
```

- [ ] **Step 4: Add IPC channels**

在 `src/shared/ipc/channels.ts` 的 `CHAT_APPROVAL_RESPONSE` 行之后加：
```ts
  CHAT_REQUEST_ASK_USER: 'chat:request-ask-user',
  CHAT_ASK_USER_RESPONSE: 'chat:ask-user-response',
```

- [ ] **Step 5: Wire AgentRunner interception**

5a. 在 `src/main/agent/AgentRunner.ts` 顶部工具/类型导入区新增：
```ts
import { interceptAskUser, type AskUserAnswer, type AskUserRequest } from '../tools/builtin/AskUserQuestionTool'
```
5b. 在 `AgentRunnerCallbacks` 接口（`onPermissionRequest?` 行之后）加：
```ts
  onAskUserRequest?: (request: AskUserRequest) => Promise<AskUserAnswer[]>
```
5c. 在派发循环中、权限闸之后、`if (!resultMessage) { resultMessage = await toolInstance.execute(...) }` 之**前**插入拦截块（用 `parsedArgs`、`permReq.id`）：
```ts
                if (!resultMessage) {
                  const askIntercept = await interceptAskUser(
                    name, parsedArgs, permReq.id, callbacks.onAskUserRequest || null
                  )
                  if (askIntercept.handled) {
                    resultMessage = askIntercept.result || ''
                    if (askIntercept.isError) isError = true
                  }
                }
```
（其后保留原 `if (!resultMessage) { resultMessage = await toolInstance.execute(...) }` 不动。）

- [ ] **Step 6: Wire chat.handlers onAskUserRequest**

在 `src/main/ipc/chat.handlers.ts` 的 `runner.run({ ... })` 回调对象中、`onPermissionRequest` 之后追加（照抄 approval 范式）：
```ts
          onAskUserRequest: (request) => {
            return new Promise((resolve) => {
              sender.send(IPC_CHANNELS.CHAT_REQUEST_ASK_USER, streamId, request)
              const responseChannel = `${IPC_CHANNELS.CHAT_ASK_USER_RESPONSE}:${request.id}`
              ipcMain.handleOnce(responseChannel, (_event, answers) => {
                resolve(answers || [])
              })
            })
          }
```

- [ ] **Step 7: Wire preload**

在 `src/preload/index.ts` 的 `stream(callbacks)` 内：
- `callbacks` 类型加 `onAskUserRequest?: (request: any) => void`。
- 新增 handler（紧邻 `approvalHandler`）：
```ts
      const askUserHandler = (_event: unknown, streamId: string, request: any) => {
        if (streamId !== activeStreamId) return
        if (callbacks.onAskUserRequest) {
          callbacks.onAskUserRequest(request)
        } else {
          // 无 handler 时回空答案作安全默认，避免主进程卡死
          ipcRenderer.invoke(`${IPC_CHANNELS.CHAT_ASK_USER_RESPONSE}:${request.id}`, []).catch(console.error)
        }
      }
```
- `cleanup()` 内加 `ipcRenderer.removeListener(IPC_CHANNELS.CHAT_REQUEST_ASK_USER, askUserHandler)`。
- 注册加 `ipcRenderer.on(IPC_CHANNELS.CHAT_REQUEST_ASK_USER, askUserHandler)`。
在 `chat` 对象（`respondToApproval` 之后）加：
```ts
    respondAskUser: (requestId: string, answers: any): Promise<void> =>
      ipcRenderer.invoke(`${IPC_CHANNELS.CHAT_ASK_USER_RESPONSE}:${requestId}`, answers)
```

- [ ] **Step 8: Add env.d.ts types**

在 `src/renderer/src/env.d.ts` 的 `chat` 块内：
- `stream` 的 `callbacks` 加 `onAskUserRequest?: (request: any) => void`。
- 加 `respondAskUser: (requestId: string, answers: any) => Promise<void>`（紧邻 `respondToApproval`）。

- [ ] **Step 9: Add chatStore ask-user state + actions**

在 `src/renderer/src/stores/chatStore.ts`：
9a. 新增类型（紧邻 `PermissionRequestState` 之后）：
```ts
export interface AskUserOptionState { label: string; description?: string; preview?: string }
export interface AskUserQuestionItemState {
  question: string
  header: string
  options: AskUserOptionState[]
  multiSelect?: boolean
}
export interface AskUserRequestState {
  id: string
  questions: AskUserQuestionItemState[]
  status: 'pending' | 'answered'
  answers?: Array<{ question: string; answer: string | string[] }>
  createdAt: number
}
```
9b. `ChatMessage` 加 `askUserRequests?: AskUserRequestState[]`。
9c. `ChatState` 接口加：
```ts
  addAskUserRequest: (msgId: string, request: Omit<AskUserRequestState, 'status' | 'createdAt'>) => void
  resolveAskUserRequest: (msgId: string, requestId: string, answers: Array<{ question: string; answer: string | string[] }>) => void
```
9d. 实现两个 action（照抄 `addPermissionRequest`/`resolvePermissionRequest` 结构，在 `resolvePermissionRequest` 之后插入）：
```ts
  addAskUserRequest: (msgId, request) => {
    set((s) => {
      const msgs = s.messages.map((m) => {
        if (m.id !== msgId) return m
        const existing = m.askUserRequests || []
        if (existing.some((item) => item.id === request.id)) return m
        return { ...m, askUserRequests: [...existing, { ...request, status: 'pending' as const, createdAt: Date.now() }] }
      })
      const activeId = s.activeSessionId
      const sessions = s.sessions.map((session) => session.id === activeId ? { ...session, messages: msgs } : session)
      return { messages: msgs, sessions }
    })
    get().persistCurrentSession()
  },
  resolveAskUserRequest: (msgId, requestId, answers) => {
    set((s) => {
      const msgs = s.messages.map((m) => {
        if (m.id !== msgId || !m.askUserRequests) return m
        return {
          ...m,
          askUserRequests: m.askUserRequests.map((r) =>
            r.id === requestId ? { ...r, status: 'answered' as const, answers } : r
          )
        }
      })
      const activeId = s.activeSessionId
      const sessions = s.sessions.map((session) => session.id === activeId ? { ...session, messages: msgs } : session)
      return { messages: msgs, sessions }
    })
    get().persistCurrentSession()
  },
```

- [ ] **Step 10: Wire useSendMessage onAskUserRequest**

在 `src/renderer/src/components/chat/hooks/useSendMessage.ts` 中：
- 从 `useChatStore` 解构出 `addAskUserRequest`（与 `addPermissionRequest` 同处）。
- 在 `stream({ ... callbacks })` 的 `onPermissionRequest` 之后加：
```ts
          onAskUserRequest: (request: any) => {
            addAskUserRequest(agentId, request)
          }
```

- [ ] **Step 11: Create AskUserQuestionWidget + CSS**

```tsx
// src/renderer/src/components/chat/AskUserQuestionWidget.tsx
import { useState } from 'react'
import './AskUserQuestionWidget.css'
import type { AskUserRequestState } from '../../stores/chatStore'

interface Props {
  msgId: string
  requests: AskUserRequestState[]
  onResolve: (msgId: string, requestId: string, answers: Array<{ question: string; answer: string | string[] }>) => void
}

export default function AskUserQuestionWidget({ msgId, requests, onResolve }: Props) {
  const pending = requests.filter((r) => r.status === 'pending')
  if (pending.length === 0) return null
  const req = pending[0]

  return (
    <div className="ask-user-widget">
      {req.questions.map((q, qi) => (
        <QuestionBlock
          key={qi}
          question={q}
          onSubmit={(answer) => {
            // 单问即整体答复；多问可扩展为收集全部后一次提交
            onResolve(msgId, req.id, [{ question: q.question, answer }])
          }}
        />
      ))}
    </div>
  )
}

function QuestionBlock({ question, onSubmit }: {
  question: AskUserRequestState['questions'][number]
  onSubmit: (answer: string | string[]) => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [other, setOther] = useState('')
  const [showOther, setShowOther] = useState(false)

  const toggle = (label: string) => {
    if (question.multiSelect) {
      setSelected((prev) => prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label])
    } else {
      setSelected([label])
    }
  }

  const submit = () => {
    if (showOther && other.trim()) { onSubmit(question.multiSelect ? [other.trim()] : other.trim()); return }
    if (selected.length === 0) return
    onSubmit(question.multiSelect ? selected : selected[0])
  }

  return (
    <div className="ask-user-question">
      <div className="ask-user-header">{question.header}</div>
      <div className="ask-user-q">{question.question}</div>
      <div className="ask-user-options">
        {question.options.map((opt) => (
          <button
            key={opt.label}
            className={`ask-user-option ${selected.includes(opt.label) ? 'selected' : ''}`}
            onClick={() => toggle(opt.label)}
          >
            <div className="ask-user-option-label">{opt.label}</div>
            {opt.description && <div className="ask-user-option-desc">{opt.description}</div>}
          </button>
        ))}
        <button className={`ask-user-option ${showOther ? 'selected' : ''}`} onClick={() => setShowOther((v) => !v)}>
          <div className="ask-user-option-label">Other…</div>
        </button>
      </div>
      {showOther && (
        <input
          className="ask-user-other-input"
          placeholder="自定义答案"
          value={other}
          onChange={(e) => setOther(e.target.value)}
        />
      )}
      <button className="ask-user-submit" onClick={submit} disabled={!showOther && selected.length === 0}>
        提交
      </button>
    </div>
  )
}
```

```css
/* src/renderer/src/components/chat/AskUserQuestionWidget.css */
.ask-user-widget { padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.ask-user-question { display: flex; flex-direction: column; gap: 8px; }
.ask-user-header { font-size: 12px; color: #888; text-transform: uppercase; }
.ask-user-q { font-size: 14px; font-weight: 600; }
.ask-user-options { display: flex; flex-direction: column; gap: 6px; }
.ask-user-option { text-align: left; padding: 8px 10px; border: 1px solid #ddd; border-radius: 8px; background: #fff; cursor: pointer; }
.ask-user-option.selected { border-color: #4c6ef5; background: #eef2ff; }
.ask-user-option-label { font-size: 13px; font-weight: 600; }
.ask-user-option-desc { font-size: 12px; color: #666; }
.ask-user-other-input { padding: 6px 8px; border: 1px solid #ddd; border-radius: 6px; }
.ask-user-submit { align-self: flex-end; padding: 6px 14px; border: none; border-radius: 6px; background: #4c6ef5; color: #fff; cursor: pointer; }
.ask-user-submit:disabled { background: #bbb; cursor: not-allowed; }
```

- [ ] **Step 12: Render Widget in ChatArea**

在 `src/renderer/src/components/chat/ChatArea.tsx`：
- 顶部加 import：`import AskUserQuestionWidget from './AskUserQuestionWidget'`。
- 从 `useChatStore` 解构 `resolveAskUserRequest`（与 `resolvePermissionRequest` 同处）。
- 加解析回调（紧邻 `handleResolvePermission`）：
```tsx
  const handleResolveAskUser = React.useCallback(async (msgId: string, requestId: string, answers: Array<{ question: string; answer: string | string[] }>) => {
    try {
      await window.api.chat.respondAskUser(requestId, answers)
    } catch (error) {
      console.warn('Failed to send ask-user response to backend:', error)
    } finally {
      resolveAskUserRequest(msgId, requestId, answers)
    }
  }, [resolveAskUserRequest])
```
- 在 `auditMessages` 的 `useMemo` 过滤条件加 `|| m.askUserRequests?.some((r: any) => r.status === 'pending')`。
- 在 auditArea 渲染块中、`{hasPendingPermission && (...)}` 之后插入：
```tsx
                  {(() => {
                    const pendingAsk = msg.askUserRequests?.filter((r: any) => r.status === 'pending') || []
                    if (pendingAsk.length === 0) return null
                    return (
                      <div className="dropdown-shadow rounded-xl mb-2">
                        <AskUserQuestionWidget
                          msgId={msg.id}
                          requests={pendingAsk}
                          onResolve={handleResolveAskUser}
                        />
                      </div>
                    )
                  })()}
```

- [ ] **Step 13: Run tests + typecheck**

Run: `npx vitest run src/tests/ask-user-question-tool.test.ts`
Expected: PASS（11 例全绿）。
Run: `npm run typecheck`
Expected: 无类型错误（preloader/renderer/store 全链路类型一致）。

- [ ] **Step 14: Commit**

```bash
git add src/main/tools/builtin/AskUserQuestionTool.ts src/shared/ipc/channels.ts src/main/agent/AgentRunner.ts src/main/ipc/chat.handlers.ts src/preload/index.ts src/renderer/src/env.d.ts src/renderer/src/stores/chatStore.ts src/renderer/src/components/chat/hooks/useSendMessage.ts src/renderer/src/components/chat/AskUserQuestionWidget.tsx src/renderer/src/components/chat/AskUserQuestionWidget.css src/renderer/src/components/chat/ChatArea.tsx src/tests/ask-user-question-tool.test.ts
git commit -m "feat(tools): add AskUserQuestion (IPC + preload + renderer widget + AgentRunner intercept)"
```
