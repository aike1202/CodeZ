# Image Input and Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add durable photo attachments that appear inside the composer and chat history, open in a reusable preview, and are sent as real visual input through OpenAI, Anthropic, and Gemini protocols.

**Architecture:** Store imported images under the Electron app data directory and persist only opaque attachment metadata in renderer sessions and the normalized model ledger. Resolve image bytes at the Main-process Provider boundary, then build each Provider's native multimodal request shape without changing assistant/tool protocol ordering. Keep composer imports in a draft scope until a session send is accepted, and preserve session attachments through soft delete and context compaction.

**Tech Stack:** Electron 31 (`ipcMain`, `ipcRenderer`, `nativeImage`), React 18, Zustand 5, TypeScript 5.5, Vitest 1.6, existing CSS and Lucide/icon components.

## Global Constraints

- Initialize PowerShell UTF-8 and use explicit UTF-8 for every command that reads or prints Chinese text, as required by `AGENTS.md`.
- Support file selection, clipboard paste, and drag/drop through one attachment import path.
- A model accepts images only when `ModelConfig.supportsVision === true`; missing values remain false for backward compatibility.
- Permit image-only messages; preserve attachment order for multi-image messages.
- Persist attachment metadata only. Never persist or log Base64, raw bytes, or absolute attachment paths.
- Resolve Base64 only in Main-process request memory immediately before Provider payload construction.
- OpenAI uses Chat Completions `image_url.url` Data URLs; Anthropic uses base64 `image/source` blocks; Gemini uses `inlineData` parts.
- Keep attachments available during the existing three-day soft-delete recovery window; remove them only on permanent deletion or orphan cleanup.
- Do not add a new runtime dependency. Use Electron `nativeImage`, existing React/CSS patterns, and existing icons.
- Legacy sessions, ledgers, and model configs without attachment fields must load unchanged.
- Do not change system, assistant, tool call, tool result, Gemini function response, or Anthropic tool protocol ordering.

---

## File Structure

### New files

- `src/shared/types/attachment.ts`: durable attachment, draft attachment, preview byte, image resolver, and Provider policy contracts.
- `src/shared/utils/imageCapabilities.ts`: model vision gate and protocol policy lookup.
- `src/main/services/AttachmentService.ts`: draft/session storage, promotion, rollback, preview reads, Provider preparation, and cleanup.
- `src/main/services/attachment/NativeImageCodec.ts`: Electron `nativeImage` decoding, thumbnailing, and bounded optimization.
- `src/main/ipc/attachment.handlers.ts`: attachment IPC registration and singleton access.
- `src/renderer/src/components/PromptArea/hooks/useImageAttachments.ts`: ordered composer import state and Blob URL cleanup.
- `src/renderer/src/components/chat/ImageAttachmentGrid.tsx`: fixed-size editable/read-only image grid.
- `src/renderer/src/components/chat/ImageAttachmentGrid.css`: grid, thumbnail, remove, loading, and unavailable states.
- `src/renderer/src/components/chat/ImagePreviewModal.tsx`: full-image modal with previous/next controls.
- `src/renderer/src/components/chat/ImagePreviewModal.css`: responsive preview modal layout.
- `src/renderer/src/components/chat/imageAttachmentState.ts`: pure send-state and preview-index helpers.
- `src/tests/image-capabilities.test.ts`: vision defaults and protocol policy coverage.
- `src/tests/attachment-service.test.ts`: storage, promotion, rollback, validation, and cleanup coverage.
- `src/tests/image-provider-payload.test.ts`: OpenAI, Anthropic, and Gemini multimodal request shape coverage.
- `src/tests/image-composer-state.test.ts`: pure composer send state and preview navigation coverage.
- `src/tests/image-message-state.test.ts`: failed-send rollback across root and active-session message projections.
- `src/tests/image-session-lifecycle.test.ts`: soft/permanent delete attachment lifecycle coverage.

### Existing files to modify

- Shared contracts: `src/shared/types/provider.ts`, `src/shared/types/context.ts`, `src/shared/types/session.ts`, `src/shared/types/index.ts`, `src/shared/ipc/channels.ts`.
- Main wiring: `src/main/index.ts`, `src/main/ipc/session.handlers.ts`, `src/main/ipc/chat.handlers.ts`.
- Context path: `src/main/services/context/SessionRuntimeCoordinator.ts`, `src/main/services/context/ContextBudgetService.ts`, `src/main/services/context/ModelContextBuilder.ts`, `src/main/services/chat/ProviderMessageAdapter.ts`.
- Provider path: `src/main/services/chat/types.ts`, `src/main/agent/AgentRunner/types.ts`, `src/main/agent/AgentRunner/index.ts`, `src/main/services/chat/OpenAIProvider.ts`, `src/main/services/chat/AnthropicProvider.ts`, `src/main/services/chat/GeminiProvider.ts`.
- Preload contracts: `src/preload/index.ts`, `src/renderer/src/env.d.ts`.
- Renderer state/send: `src/renderer/src/stores/chatStore/types.ts`, `src/renderer/src/stores/chatStore/slices/messageSlice.ts`, `src/renderer/src/components/chat/hooks/useSendMessage.ts`, `src/renderer/src/components/PromptArea/types.ts`, `src/renderer/src/components/PromptArea/hooks/usePromptEditor.ts`.
- Renderer UI: `src/renderer/src/components/PromptArea/index.tsx`, `src/renderer/src/components/PromptArea/PromptArea.css`, `src/renderer/src/components/PromptArea/components/PlusActionMenu.tsx`, `src/renderer/src/components/chat/ChatArea/components/ChatMessageList.tsx`.
- User-message bubble layout: `src/renderer/src/App.css`.
- Model settings: `src/renderer/src/components/SettingsPanel.tsx`, `src/renderer/src/components/SettingsPanel.css`.
- Existing regression tests: `src/tests/send-message-payload.test.ts`, `src/tests/provider-message-adapter.test.ts`, `src/tests/context-budget-service.test.ts`, `src/tests/session-runtime-coordinator.test.ts`, `src/tests/session-store-runtime.test.ts`.

---

### Task 1: Shared Attachment Contracts and Vision Capability

**Files:**
- Create: `src/shared/types/attachment.ts`
- Create: `src/shared/utils/imageCapabilities.ts`
- Create: `src/tests/image-capabilities.test.ts`
- Modify: `src/shared/types/provider.ts`
- Modify: `src/shared/types/context.ts`
- Modify: `src/shared/types/session.ts`
- Modify: `src/shared/types/index.ts`
- Modify: `src/renderer/src/stores/chatStore/types.ts`
- Modify: `src/renderer/src/components/SettingsPanel.tsx`
- Modify: `src/renderer/src/components/SettingsPanel.css`

**Interfaces:**
- Produces: `ImageAttachment`, `DraftImageAttachment`, `ComposerImageAttachment`, `ResolvedImageAttachment`, `ResolveImageAttachment`, `ProviderImagePolicy`, `supportsImageInput(model)`, and `getProviderImagePolicy(apiFormat)`.
- Consumers: Tasks 2-8 use these exact shared contracts.

- [x] **Step 1: Write the failing capability test**

```ts
// src/tests/image-capabilities.test.ts
import { describe, expect, it } from 'vitest'
import { getProviderImagePolicy, supportsImageInput } from '../shared/utils/imageCapabilities'

describe('image capabilities', () => {
  it('requires an explicit vision opt-in', () => {
    expect(supportsImageInput(undefined)).toBe(false)
    expect(supportsImageInput({ supportsVision: false })).toBe(false)
    expect(supportsImageInput({ supportsVision: true })).toBe(true)
  })

  it('provides protocol-specific limits without a renderer-only global limit', () => {
    expect(getProviderImagePolicy('openai')).toMatchObject({
      acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      maxImages: 500,
      maxTotalBytes: 50 * 1024 * 1024
    })
    expect(getProviderImagePolicy('anthropic')).toMatchObject({
      maxImages: 100,
      maxImageBytes: 5 * 1024 * 1024
    })
    expect(getProviderImagePolicy('gemini')).toMatchObject({
      maxTotalBytes: 20 * 1024 * 1024
    })
  })
})
```

- [x] **Step 2: Run the focused test and verify the missing module failure**

Run: `npm test -- src/tests/image-capabilities.test.ts`

Expected: FAIL because `shared/utils/imageCapabilities` does not exist.

- [x] **Step 3: Add the shared contracts and capability lookup**

```ts
// src/shared/types/attachment.ts
import type { ApiFormat } from './provider'

export type ImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp'

export interface ImageAttachmentBase {
  id: string
  kind: 'image'
  name: string
  mimeType: ImageMimeType
  width: number
  height: number
  sizeBytes: number
  storageKey: string
}

export interface ImageAttachment extends ImageAttachmentBase {
  scope: 'session'
  sessionId: string
}

export interface DraftImageAttachment extends ImageAttachmentBase {
  scope: 'draft'
  draftId: string
}

export type ComposerImageAttachment = ImageAttachment | DraftImageAttachment

export interface AttachmentPreviewBytes {
  mimeType: ImageMimeType
  bytes: Uint8Array
}

export interface ResolvedImageAttachment {
  mimeType: ImageMimeType
  dataBase64: string
}

export type ResolveImageAttachment = (
  attachment: ImageAttachment
) => Promise<ResolvedImageAttachment>

export interface ProviderImagePolicy {
  apiFormat: ApiFormat
  acceptedMimeTypes: ImageMimeType[]
  maxImages?: number
  maxImageBytes?: number
  /** Budget for the Base64-encoded image contribution to the request body. */
  maxTotalBytes: number
}

export interface PendingPromptDraft {
  text: string
  attachments: ComposerImageAttachment[]
}
```

```ts
// src/shared/utils/imageCapabilities.ts
import type { ApiFormat, ModelConfig } from '../types/provider'
import type { ProviderImagePolicy } from '../types/attachment'

const MIB = 1024 * 1024

const POLICIES: Record<ApiFormat, ProviderImagePolicy> = {
  openai: {
    apiFormat: 'openai',
    acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxImages: 500,
    maxImageBytes: 50 * MIB,
    maxTotalBytes: 50 * MIB
  },
  anthropic: {
    apiFormat: 'anthropic',
    acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxImages: 100,
    maxImageBytes: 5 * MIB,
    maxTotalBytes: 32 * MIB
  },
  gemini: {
    apiFormat: 'gemini',
    acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxImageBytes: 20 * MIB,
    maxTotalBytes: 20 * MIB
  }
}

export function supportsImageInput(
  model: Pick<ModelConfig, 'supportsVision'> | undefined
): boolean {
  return model?.supportsVision === true
}

export function getProviderImagePolicy(apiFormat: ApiFormat | undefined): ProviderImagePolicy {
  return POLICIES[apiFormat || 'openai']
}
```

Add `supportsVision?: boolean` to `ModelConfig`. Add `attachments?: ImageAttachment[]` to `NormalizedModelMessage`, `StreamRequestV2.input`, shared `SessionData.messages`, shared Provider `ChatMessage`, and renderer `ChatMessage`. Use type-only imports in `provider.ts` and `attachment.ts` to avoid a runtime module cycle. Export attachment types from `src/shared/types/index.ts`. Keep `pendingPrompt` unchanged until Task 8 so earlier tasks remain independently type-correct.

In `SettingsPanel.tsx`, add `supportsVision?: boolean` to `ModelFormData`, teach `updateModel` to accept booleans, and add this checkbox inside each `.settings-model-card`:

```tsx
<label className="settings-model-vision-toggle">
  <input
    type="checkbox"
    checked={m.supportsVision === true}
    onChange={(event) => updateModel(idx, 'supportsVision', event.target.checked)}
  />
  支持图片输入
</label>
```

Use a quiet inline row in `SettingsPanel.css`; do not add a nested card.

- [x] **Step 4: Run focused tests and type checking**

Run: `npm test -- src/tests/image-capabilities.test.ts`

Run: `npm run typecheck`

Expected: capability tests PASS and type checking PASS after all newly required optional fields compile.

- [x] **Step 5: Commit the shared contract**

```powershell
git add src/shared/types/attachment.ts src/shared/utils/imageCapabilities.ts src/shared/types/provider.ts src/shared/types/context.ts src/shared/types/session.ts src/shared/types/index.ts src/renderer/src/stores/chatStore/types.ts src/renderer/src/components/SettingsPanel.tsx src/renderer/src/components/SettingsPanel.css src/tests/image-capabilities.test.ts
git commit -m "Add image attachment contracts and model capability"
```

---

### Task 2: Attachment Storage, Validation, and Optimization

**Files:**
- Create: `src/main/services/attachment/NativeImageCodec.ts`
- Create: `src/main/services/AttachmentService.ts`
- Create: `src/tests/attachment-service.test.ts`

**Interfaces:**
- Consumes: Task 1 attachment and policy types.
- Produces: `AttachmentService.importDraft`, `promoteDrafts`, `rollbackPromotion`, `discardDrafts`, `readPreview`, `prepareSessionImages`, `deleteSession`, and `cleanupOrphans`.

- [x] **Step 1: Write failing service tests with an injected codec**

```ts
// src/tests/attachment-service.test.ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { AttachmentService, type ImageCodec } from '../main/services/AttachmentService'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const codec: ImageCodec = {
  inspect: async (bytes) => ({ bytes, mimeType: 'image/jpeg', width: 800, height: 600 }),
  thumbnail: async () => new Uint8Array([9, 8, 7]),
  optimize: async (bytes) => ({ bytes, mimeType: 'image/jpeg', width: 800, height: 600 })
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codez-attachments-'))
  roots.push(root)
  return { root, service: new AttachmentService(root, codec) }
}

describe('AttachmentService', () => {
  it('imports a draft and exposes thumbnail bytes without an absolute path', async () => {
    const { service } = await fixture()
    const draft = await service.importDraft({
      name: 'photo.jpg', declaredMimeType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3])
    })
    expect(draft).toMatchObject({ scope: 'draft', kind: 'image', mimeType: 'image/jpeg' })
    expect(draft.storageKey).not.toMatch(/^[A-Za-z]:[\\/]|^\//)
    await expect(service.readPreview(draft, 'thumbnail')).resolves.toMatchObject({
      bytes: new Uint8Array([9, 8, 7])
    })
  })

  it('promotes by copying, keeps the draft for retry, and rolls back only copies', async () => {
    const { service } = await fixture()
    const draft = await service.importDraft({
      name: 'photo.jpg', declaredMimeType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3])
    })
    const [stored] = await service.promoteDrafts('session-1', [draft])
    await expect(service.readPreview(draft, 'original')).resolves.toBeTruthy()
    await service.rollbackPromotion('session-1', [stored.id])
    await expect(service.readPreview(stored, 'original')).rejects.toThrow('Attachment not found')
  })

  it('keeps live sessions and removes orphan session directories', async () => {
    const { root, service } = await fixture()
    const draft = await service.importDraft({
      name: 'photo.jpg', declaredMimeType: 'image/jpeg', bytes: new Uint8Array([1])
    })
    await service.promoteDrafts('live', [draft])
    await service.promoteDrafts('orphan', [draft])
    await service.cleanupOrphans(new Set(['live']))
    await expect(readFile(path.join(root, 'sessions', 'live', draft.id, 'original'))).resolves.toBeTruthy()
    await expect(readFile(path.join(root, 'sessions', 'orphan', draft.id, 'original'))).rejects.toThrow()
  })

  it('removes drafts after the 24 hour retry window', async () => {
    const { service } = await fixture()
    const draft = await service.importDraft({
      name: 'photo.jpg', declaredMimeType: 'image/jpeg', bytes: new Uint8Array([1])
    })
    await service.cleanupOrphans(new Set(), Date.now() + 25 * 60 * 60 * 1000)
    await expect(service.readPreview(draft, 'original')).rejects.toThrow('Attachment not found')
  })
})
```

- [x] **Step 2: Run the test and verify the missing service failure**

Run: `npm test -- src/tests/attachment-service.test.ts`

Expected: FAIL because `AttachmentService` does not exist.

- [x] **Step 3: Implement the codec boundary and service**

Define this testable codec contract in `AttachmentService.ts`:

```ts
export interface DecodedImage {
  bytes: Uint8Array
  mimeType: ImageMimeType
  width: number
  height: number
}

export interface ImageCodec {
  inspect(bytes: Uint8Array, declaredMimeType?: string): Promise<DecodedImage>
  thumbnail(image: DecodedImage): Promise<Uint8Array>
  optimize(image: DecodedImage, maxBytes: number): Promise<DecodedImage>
}
```

`NativeImageCodec.inspect` must reject empty Electron `nativeImage` values, detect canonical MIME from magic bytes, and keep only JPEG/PNG/WebP. `thumbnail` must resize within `320x320` without upscaling and emit JPEG bytes. `optimize` must return the original when it already fits; otherwise try JPEG qualities `88, 80, 72, 64` while reducing the longest edge through `4096, 3072, 2048, 1536, 1024`, and throw `IMAGE_CANNOT_FIT_PROVIDER_LIMIT` if none fit.

Implement storage with opaque keys and path containment:

```ts
private pathFor(storageKey: string, variant: 'original' | 'thumbnail'): string {
  const relative = storageKey.replace(/^attachment:/, '')
  const resolved = path.resolve(this.rootPath, relative, variant)
  const root = path.resolve(this.rootPath) + path.sep
  if (!resolved.startsWith(root)) throw new Error('Invalid attachment storage key')
  return resolved
}
```

Write `original`, `thumbnail`, and UTF-8 `meta.json` beneath a random attachment ID directory. `promoteDrafts` copies drafts into `sessions/<sessionId>`, passes through existing session attachments only when their `sessionId` matches, and returns `scope: 'session'` objects in input order. On any copy failure, delete copies created by that call before rethrowing.

Implement this request-level boundary:

```ts
async prepareSessionImages(
  sessionId: string,
  attachments: ImageAttachment[],
  policy: ProviderImagePolicy
): Promise<ResolveImageAttachment>
```

It must reject a mismatched scope/session, enforce optional count/per-image limits and total bytes across the full request, optimize oversized images through the codec, and return a resolver backed by an in-memory map keyed by attachment ID. Count duplicate references as separate payload occurrences even when byte reads are deduplicated. Estimate Base64 contribution with `Math.ceil(sizeBytes / 3) * 4`; when the total exceeds `maxTotalBytes`, assign a proportional per-occurrence byte target, optimize offending images, recalculate, and throw `IMAGE_REQUEST_TOO_LARGE` only if the optimized set still cannot fit. The resolver returns `{ mimeType, dataBase64 }`; Base64 is never written. `cleanupOrphans(liveSessionIds, now = Date.now())` also removes draft directories whose metadata is older than 24 hours.

- [x] **Step 4: Run service tests**

Run: `npm test -- src/tests/attachment-service.test.ts`

Expected: all AttachmentService tests PASS.

- [x] **Step 5: Commit the attachment core**

```powershell
git add src/main/services/attachment/NativeImageCodec.ts src/main/services/AttachmentService.ts src/tests/attachment-service.test.ts
git commit -m "Add managed image attachment storage"
```

---

### Task 3: Attachment IPC, Stream Start Acknowledgement, and App Lifecycle

**Files:**
- Create: `src/main/ipc/attachment.handlers.ts`
- Create: `src/tests/image-session-lifecycle.test.ts`
- Modify: `src/shared/ipc/channels.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/env.d.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/session.handlers.ts`

**Interfaces:**
- Consumes: `AttachmentService` from Task 2.
- Produces: `window.api.attachment.*` and `ChatStreamHandle { stop, started }` for Task 6.

- [x] **Step 1: Write the failing session lifecycle test**

```ts
// src/tests/image-session-lifecycle.test.ts
import { describe, expect, it, vi } from 'vitest'
import { deleteSessionWithAttachments } from '../main/ipc/attachment.handlers'

describe('image session lifecycle', () => {
  it('keeps attachments on soft delete and removes them on permanent delete', async () => {
    const session = { id: 's1', isDeleted: false }
    const store = {
      get: vi.fn(() => ({ ...session })),
      delete: vi.fn(async () => { session.isDeleted = true })
    }
    const attachments = { deleteSession: vi.fn(async () => undefined) }

    await deleteSessionWithAttachments(store, attachments, 's1')
    expect(attachments.deleteSession).not.toHaveBeenCalled()

    store.get.mockReturnValue({ id: 's1', isDeleted: true })
    await deleteSessionWithAttachments(store, attachments, 's1')
    expect(attachments.deleteSession).toHaveBeenCalledWith('s1')
  })
})
```

- [x] **Step 2: Run the test and verify the missing helper failure**

Run: `npm test -- src/tests/image-session-lifecycle.test.ts`

Expected: FAIL because `attachment.handlers` does not exist.

- [x] **Step 3: Register attachment IPC and preload methods**

Add channels for import, promote, rollback, discard, and preview. Expose these exact methods:

```ts
attachment: {
  importDraft: (input: {
    name: string
    declaredMimeType: string
    bytes: Uint8Array
  }): Promise<DraftImageAttachment>
  promoteDrafts: (
    sessionId: string,
    attachments: ComposerImageAttachment[]
  ): Promise<ImageAttachment[]>
  rollbackPromotion: (sessionId: string, attachmentIds: string[]) => Promise<void>
  discardDrafts: (draftIds: string[]) => Promise<void>
  readPreview: (
    attachment: ComposerImageAttachment,
    variant: 'thumbnail' | 'original'
  ): Promise<AttachmentPreviewBytes>
}
```

In the Main handler, reject byte payloads that are not `Uint8Array` or exceed `100 * 1024 * 1024` before invoking the service. Do not accept arbitrary paths.

Change `window.api.chat.stream` to return:

```ts
export interface ChatStreamHandle {
  stop: () => void
  started: Promise<void>
}
```

Resolve `started` only after `CHAT_STREAM_START` returns the requested stream ID. Reject it on IPC failure or mismatched ID. Preserve current cleanup behavior behind `stop`.

- [x] **Step 4: Wire startup orphan cleanup and permanent session deletion**

Export `getAttachmentService()` from the handler. After `initializeSessionStore()` in `main/index.ts`, run:

```ts
const attachments = getAttachmentService()
await attachments.cleanupOrphans(new Set(sessionStore.getAll().map((session) => session.id)))
```

Register attachment IPC before creating the window. Implement `deleteSessionWithAttachments` so it inspects `wasDeleted` before calling `SessionStore.delete`; only a second delete calls `AttachmentService.deleteSession`. Startup orphan cleanup handles sessions that expire during `SessionStore.load()` and old sessions evicted by the 50-session cap.

```ts
export async function deleteSessionWithAttachments(
  store: Pick<SessionStore, 'get' | 'delete'>,
  attachments: Pick<AttachmentService, 'deleteSession'>,
  sessionId: string
): Promise<void> {
  const wasDeleted = store.get(sessionId)?.isDeleted === true
  await store.delete(sessionId)
  if (wasDeleted) await attachments.deleteSession(sessionId)
}
```

- [x] **Step 5: Run lifecycle, session, and type checks**

Run: `npm test -- src/tests/image-session-lifecycle.test.ts src/tests/session-store-runtime.test.ts`

Run: `npm run typecheck`

Expected: focused tests PASS and preload/Main/Renderer types agree.

- [x] **Step 6: Commit IPC and lifecycle wiring**

```powershell
git add src/main/ipc/attachment.handlers.ts src/shared/ipc/channels.ts src/preload/index.ts src/renderer/src/env.d.ts src/main/index.ts src/main/ipc/session.handlers.ts src/tests/image-session-lifecycle.test.ts
git commit -m "Wire image attachment IPC and lifecycle"
```

---

### Task 4: Persist Attachments in the Model Ledger and Budget

**Files:**
- Modify: `src/main/services/context/SessionRuntimeCoordinator.ts`
- Modify: `src/main/services/context/ContextBudgetService.ts`
- Modify: `src/main/services/context/ModelContextBuilder.ts`
- Modify: `src/main/services/chat/ProviderMessageAdapter.ts`
- Modify: `src/tests/session-runtime-coordinator.test.ts`
- Modify: `src/tests/context-budget-service.test.ts`
- Modify: `src/tests/provider-message-adapter.test.ts`

**Interfaces:**
- Consumes: `ImageAttachment` from Task 1.
- Produces: ledger messages and Provider `ChatMessage.attachments` used by Task 5.

- [x] **Step 1: Add failing ledger and adapter tests**

Add to `session-runtime-coordinator.test.ts`:

```ts
it('allows an image-only turn and persists attachment metadata', async () => {
  const { ledger, runtime } = await fixture()
  const attachment = {
    id: 'img1', kind: 'image' as const, name: 'photo.jpg', mimeType: 'image/jpeg' as const,
    width: 800, height: 600, sizeBytes: 123, storageKey: 'attachment:sessions/s1/img1',
    scope: 'session' as const, sessionId: 's1'
  }
  const turn = await runtime.beginTurn({
    sessionId: 's1', contextScopeId: 'main', text: '', attachments: [attachment]
  })
  const message = (await ledger.load('s1')).scopes.main.activeMessages[0]
  expect(message.attachments).toEqual([attachment])
  await runtime.completeTurn(turn, { stopReason: 'stop' })
})
```

Add to `provider-message-adapter.test.ts`:

```ts
it('preserves user attachment references without changing tool messages', () => {
  const attachment = {
    id: 'img1', kind: 'image' as const, name: 'photo.jpg', mimeType: 'image/jpeg' as const,
    width: 800, height: 600, sizeBytes: 123, storageKey: 'attachment:sessions/s1/img1',
    scope: 'session' as const, sessionId: 's1'
  }
  const items: ModelContextItem[] = [
    { kind: 'user', message: normalized({ role: 'user', content: 'inspect', attachments: [attachment] }) }
  ]
  expect(ProviderMessageAdapter.toChatMessages(items)).toEqual([
    { role: 'user', content: 'inspect', attachments: [attachment] }
  ])
})
```

- [x] **Step 2: Add the failing image budget test**

```ts
it('includes conservative image tokens in current input and history', () => {
  const image = { width: 1024, height: 1024 }
  expect(service.estimateImageTokens(image)).toBeGreaterThan(0)
  const snapshot = service.measureRequest({
    capabilities: { contextWindowTokens: 20_000 },
    systemPrompt: '', recentHistory: [], currentInput: '', currentAttachments: [image], historyVersion: 1
  })
  expect(snapshot.currentInputTokens).toBe(service.estimateImageTokens(image))
})
```

- [x] **Step 3: Run focused tests and verify failures**

Run: `npm test -- src/tests/session-runtime-coordinator.test.ts src/tests/provider-message-adapter.test.ts src/tests/context-budget-service.test.ts`

Expected: FAIL because turn input rejects empty text, attachments are not adapted, and image token APIs do not exist.

- [x] **Step 4: Thread attachments through runtime and context**

Add `attachments?: ImageAttachment[]` to `BeginTurnInput` and `RuntimeTurnHandle`. Change the guard to:

```ts
if (!input.text.trim() && !input.attachments?.length) {
  throw new Error('Turn input is empty')
}
```

Copy attachment objects into the persisted user message and public handle. In `ProviderMessageAdapter`, include `attachments: message.attachments?.map((item) => ({ ...item }))` only for user messages that have attachments.

Add this explicit conservative estimator:

```ts
estimateImageTokens(image: Pick<ImageAttachment, 'width' | 'height'>): number {
  const tiles = Math.max(1, Math.ceil(image.width / 512) * Math.ceil(image.height / 512))
  return 85 + tiles * 170
}
```

`MeasureRequestInput` gains `currentAttachments`. `measureRequest` adds their estimate to `currentInputTokens`. `estimateValueTokens` must recognize objects with an `attachments` array and add image tokens instead of relying only on serialized metadata. `assertCurrentInputFits` accepts attachments and uses the combined estimate.

Pass `current.attachments` from `ModelContextBuilder` into assertion and measurement. Do not copy Base64 into any context type.

- [x] **Step 5: Run focused tests**

Run: `npm test -- src/tests/session-runtime-coordinator.test.ts src/tests/provider-message-adapter.test.ts src/tests/context-budget-service.test.ts`

Expected: all focused tests PASS.

- [x] **Step 6: Commit ledger support**

```powershell
git add src/main/services/context/SessionRuntimeCoordinator.ts src/main/services/context/ContextBudgetService.ts src/main/services/context/ModelContextBuilder.ts src/main/services/chat/ProviderMessageAdapter.ts src/tests/session-runtime-coordinator.test.ts src/tests/context-budget-service.test.ts src/tests/provider-message-adapter.test.ts
git commit -m "Persist image attachments in model context"
```

---

### Task 5: Build Native Multimodal Provider Payloads

**Files:**
- Create: `src/tests/image-provider-payload.test.ts`
- Modify: `src/shared/types/provider.ts`
- Modify: `src/main/services/chat/types.ts`
- Modify: `src/main/agent/AgentRunner/types.ts`
- Modify: `src/main/agent/AgentRunner/index.ts`
- Modify: `src/main/services/chat/OpenAIProvider.ts`
- Modify: `src/main/services/chat/AnthropicProvider.ts`
- Modify: `src/main/services/chat/GeminiProvider.ts`

**Interfaces:**
- Consumes: `ChatMessage.attachments`, `ResolveImageAttachment`, and the request-level image preparation callback.
- Produces: `resolveOpenAIMessages`, `buildAnthropicMessages`, and `buildGeminiContents`, each exported for deterministic tests.

- [x] **Step 1: Write failing Provider payload tests**

```ts
// src/tests/image-provider-payload.test.ts
import { describe, expect, it } from 'vitest'
import { resolveOpenAIMessages } from '../main/services/chat/OpenAIProvider'
import { buildAnthropicMessages } from '../main/services/chat/AnthropicProvider'
import { buildGeminiContents } from '../main/services/chat/GeminiProvider'

const attachment = {
  id: 'img1', kind: 'image' as const, name: 'photo.jpg', mimeType: 'image/jpeg' as const,
  width: 800, height: 600, sizeBytes: 4, storageKey: 'attachment:sessions/s1/img1',
  scope: 'session' as const, sessionId: 's1'
}
const resolveImage = async () => ({ mimeType: 'image/jpeg' as const, dataBase64: 'AQIDBA==' })

describe('multimodal provider payloads', () => {
  it('builds OpenAI Chat Completions image_url Data URLs', async () => {
    const result = await resolveOpenAIMessages([
      { role: 'user', content: 'inspect', attachments: [attachment] }
    ], resolveImage)
    expect(result[0].content).toEqual([
      { type: 'text', text: 'inspect' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQIDBA==' } }
    ])
  })

  it('builds Anthropic source blocks and preserves tool result order', async () => {
    const result = await buildAnthropicMessages([
      { role: 'user', content: '', attachments: [attachment] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', content: 'ok', tool_call_id: 'c1', name: 'Read' }
    ], resolveImage)
    expect(result[0].content).toEqual([{
      type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AQIDBA==' }
    }])
    expect(result.at(-1)?.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1' })
  })

  it('builds Gemini inlineData and keeps function responses separate', async () => {
    const result = await buildGeminiContents([
      { role: 'user', content: 'inspect', attachments: [attachment] }
    ], resolveImage)
    expect(result.contents).toEqual([{
      role: 'user', parts: [
        { text: 'inspect' },
        { inlineData: { mimeType: 'image/jpeg', data: 'AQIDBA==' } }
      ]
    }])
  })
})
```

- [x] **Step 2: Run the Provider test and verify missing exports**

Run: `npm test -- src/tests/image-provider-payload.test.ts`

Expected: FAIL because the three payload builder exports do not exist.

- [x] **Step 3: Add resolver plumbing without changing persisted content**

Keep the existing `ChatMessage.content` string and Task 1 `attachments` field, and add `resolveImage?: ResolveImageAttachment` to `ChatRequestConfig`. Add this callback to `AgentRunConfig`:

```ts
prepareImages?: (attachments: ImageAttachment[]) => Promise<ResolveImageAttachment>
```

Immediately before each `ChatService.streamChat` call, `AgentRunner` collects attachments from `allMessages` in message order, calls `prepareImages` once, and passes the returned `resolveImage` in `ChatRequestConfig`. This validates count and total bytes for the complete context on every Agent loop while keeping protocol builders deterministic.

In OpenAI, map only user messages with attachments:

```ts
export async function resolveOpenAIMessages(
  messages: ChatMessage[],
  resolveImage?: ResolveImageAttachment
): Promise<any[]> {
  return Promise.all(messages.map(async (message) => {
    if (message.role !== 'user' || !message.attachments?.length) return message
    if (!resolveImage) throw new Error('Image resolver is unavailable')
    const images = await Promise.all(message.attachments.map(resolveImage))
    return {
      ...message,
      attachments: undefined,
      content: [
        ...(message.content?.trim() ? [{ type: 'text', text: message.content }] : []),
        ...images.map((image) => ({
          type: 'image_url',
          image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` }
        }))
      ]
    }
  }))
}
```

Extract current Anthropic and Gemini message conversion loops into the exported async builders. Add image blocks only for user messages, omit empty text blocks, and keep all existing tool/function separation behavior byte-for-byte otherwise. Ensure Provider debug logs continue to print only message/content counts.

- [x] **Step 4: Run Provider and existing chat tests**

Run: `npm test -- src/tests/image-provider-payload.test.ts src/tests/chat-service.test.ts src/tests/chat-provider-usage.test.ts src/tests/provider-message-adapter.test.ts`

Expected: multimodal and existing protocol tests PASS.

- [x] **Step 5: Commit Provider support**

```powershell
git add src/shared/types/provider.ts src/main/services/chat/types.ts src/main/agent/AgentRunner/types.ts src/main/agent/AgentRunner/index.ts src/main/services/chat/OpenAIProvider.ts src/main/services/chat/AnthropicProvider.ts src/main/services/chat/GeminiProvider.ts src/tests/image-provider-payload.test.ts
git commit -m "Send images through multimodal provider payloads"
```

---

### Task 6: Promote Attachments and Send Them Reliably

**Files:**
- Modify: `src/main/ipc/chat.handlers.ts`
- Modify: `src/renderer/src/components/chat/hooks/useSendMessage.ts`
- Modify: `src/renderer/src/stores/chatStore/types.ts`
- Modify: `src/renderer/src/stores/chatStore/slices/messageSlice.ts`
- Modify: `src/tests/send-message-payload.test.ts`
- Create: `src/tests/image-message-state.test.ts`

**Interfaces:**
- Consumes: attachment IPC, `ChatStreamHandle.started`, vision capability, ledger attachment input, and Provider resolver.
- Produces: `handleSendMessage(...): Promise<boolean>` and attachment-aware user message state.

- [x] **Step 1: Extend the failing renderer payload test**

```ts
it('passes attachment references separately from text metadata', () => {
  const attachment = {
    id: 'img1', kind: 'image' as const, name: 'photo.jpg', mimeType: 'image/jpeg' as const,
    width: 800, height: 600, sizeBytes: 4, storageKey: 'attachment:sessions/s1/img1',
    scope: 'session' as const, sessionId: 's1'
  }
  const input = buildChatStreamInput('inspect', [], 'ui-1', false, [attachment])
  expect(input).toMatchObject({ text: 'inspect', attachments: [attachment] })
  expect(JSON.stringify(input)).not.toContain('base64')
})
```

Create `src/tests/image-message-state.test.ts` with a local fixture and a pure reducer assertion:

```ts
import { describe, expect, it } from 'vitest'
import { removeMessagesFromState } from '../renderer/src/stores/chatStore/slices/messageSlice'
import type { ChatState } from '../renderer/src/stores/chatStore/types'

describe('image message state', () => {
  it('removes a failed user/agent pair from root and active session projections', () => {
    const messages = [
      { id: 'u1', role: 'user' as const, content: 'inspect' },
      { id: 'a1', role: 'agent' as const, content: '', streaming: true }
    ]
    const state = {
      activeSessionId: 's1',
      messages,
      sessions: [{ id: 's1', projectId: 'p1', summary: 'x', relativeTime: 'now', messages }]
    } as ChatState
    const next = removeMessagesFromState(state, new Set(['u1', 'a1']))
    expect(next.messages).toEqual([])
    expect(next.sessions[0].messages).toEqual([])
  })
})
```

- [x] **Step 2: Run the focused tests and verify signature failures**

Run: `npm test -- src/tests/send-message-payload.test.ts src/tests/image-message-state.test.ts`

Expected: FAIL because stream input and message actions do not accept attachments.

- [x] **Step 3: Add attachment-aware message state and rollback**

Use these exact store signatures:

```ts
addUserMessage: (content: string, attachments?: ImageAttachment[]) => ChatMessage
removeMessages: (messageIds: string[]) => void
```

`removeMessages` must update both the active root `messages` list and the matching `ChatSession.messages`. Keep `pendingPrompt` as the existing string until Task 8 so this task remains independently type-correct.

```ts
export function removeMessagesFromState(
  state: ChatState,
  messageIds: Set<string>
): Pick<ChatState, 'messages' | 'sessions'> {
  const messages = state.messages.filter((message) => !messageIds.has(message.id))
  return {
    messages,
    sessions: state.sessions.map((session) => session.id === state.activeSessionId
      ? { ...session, messages }
      : session)
  }
}
```

- [x] **Step 4: Promote drafts and validate the selected model before sending**

Extend `buildChatStreamInput` with an attachment argument. In `handleSendMessage`:

1. Return `false` for missing workspace/provider.
2. Resolve the exact selected `ModelConfig`.
3. If composer attachments exist and `supportsImageInput(modelConfig)` is false, show `当前模型未启用图片输入，请切换模型或在模型设置中开启。` and return `false` without creating messages.
4. Create the session if needed.
5. Call `window.api.attachment.promoteDrafts(sid, composerAttachments)`.
6. Add and persist the user message with promoted attachments.
7. Start the Agent reply and call `window.api.chat.stream`.
8. Await `handle.started` before returning `true`.
9. On start rejection, call `removeMessages`, derive rollback IDs with `promoted.filter((_, index) => composerAttachments[index].scope === 'draft').map((item) => item.id)`, call `rollbackPromotion` only for those IDs, persist the repaired session, and return `false`.
10. On success, discard only original draft IDs; session attachments restored by revert are not discarded.

Keep the existing system-message positional parameter and use this exact internal signature:

```ts
async (
  message: string,
  modelName: string,
  isSystem = false,
  attachments: ComposerImageAttachment[] = []
): Promise<boolean>
```

Every early branch returns a boolean. Client-side slash actions return `true` after they complete; validation or configuration failures return `false`. The existing PromptArea still calls this function with two arguments in this task. Task 7 adds the explicit composer attachment adapter; existing system callers continue to pass `true` as the third argument.

In `chat.handlers.ts`, validate `modelConfig?.supportsVision === true` when `request.input.attachments` is non-empty, pass attachments into `beginTurn`, and provide this request-level preparation callback to `runner.run`:

```ts
prepareImages: (attachments) => attachmentService.prepareSessionImages(
  request.sessionId,
  attachments,
  getProviderImagePolicy(modelConfig?.apiFormat || config.apiFormat)
)
```

Replace the current pure-text request guard with:

```ts
const hasText = Boolean(request.input?.text?.trim())
const hasImages = Boolean(request.input?.attachments?.length)
if (!request.sessionId || (!hasText && !hasImages)) {
  sender.send(IPC_CHANNELS.CHAT_STREAM_ERROR, streamId, '会话 ID 和本次输入不能为空')
  return streamId
}
```

Store `handle.stop` through the existing `setStreamCleanup` action; do not store the whole stream handle in Zustand.

- [x] **Step 5: Run send, runtime, and type checks**

Run: `npm test -- src/tests/send-message-payload.test.ts src/tests/image-message-state.test.ts src/tests/session-runtime-coordinator.test.ts src/tests/provider-message-adapter.test.ts`

Run: `npm run typecheck`

Expected: focused tests and type checking PASS.

- [x] **Step 6: Commit the reliable send flow**

```powershell
git add src/main/ipc/chat.handlers.ts src/renderer/src/components/chat/hooks/useSendMessage.ts src/renderer/src/stores/chatStore/types.ts src/renderer/src/stores/chatStore/slices/messageSlice.ts src/tests/send-message-payload.test.ts src/tests/image-message-state.test.ts
git commit -m "Send managed image attachments with chat messages"
```

---

### Task 7: Composer Selection, Paste, Drag/Drop, Thumbnails, and Preview

**Files:**
- Create: `src/renderer/src/components/PromptArea/hooks/useImageAttachments.ts`
- Create: `src/renderer/src/components/chat/imageAttachmentState.ts`
- Create: `src/renderer/src/components/chat/ImageAttachmentGrid.tsx`
- Create: `src/renderer/src/components/chat/ImageAttachmentGrid.css`
- Create: `src/renderer/src/components/chat/ImagePreviewModal.tsx`
- Create: `src/renderer/src/components/chat/ImagePreviewModal.css`
- Create: `src/tests/image-composer-state.test.ts`
- Modify: `src/renderer/src/components/PromptArea/index.tsx`
- Modify: `src/renderer/src/components/PromptArea/types.ts`
- Modify: `src/renderer/src/components/PromptArea/hooks/usePromptEditor.ts`
- Modify: `src/renderer/src/components/PromptArea/components/PlusActionMenu.tsx`
- Modify: `src/renderer/src/components/PromptArea/PromptArea.css`
- Modify: `src/renderer/src/components/chat/ChatArea/index.tsx`

**Interfaces:**
- Consumes: attachment preload API and `handleSendMessage(): Promise<boolean>`.
- Produces: reusable image grid/preview components also used by Task 8.

- [x] **Step 1: Write failing pure UI state tests**

```ts
// src/tests/image-composer-state.test.ts
import { describe, expect, it } from 'vitest'
import { evaluateImageSendState, nextPreviewIndex } from '../renderer/src/components/chat/imageAttachmentState'

describe('image composer state', () => {
  it('allows image-only sends and blocks importing or unsupported models', () => {
    expect(evaluateImageSendState({ text: '', attachmentCount: 1, importing: false, supportsVision: true }))
      .toEqual({ canSend: true, reason: null })
    expect(evaluateImageSendState({ text: '', attachmentCount: 1, importing: true, supportsVision: true }).canSend)
      .toBe(false)
    expect(evaluateImageSendState({ text: 'inspect', attachmentCount: 1, importing: false, supportsVision: false }).reason)
      .toBe('当前模型未启用图片输入')
  })

  it('wraps preview navigation', () => {
    expect(nextPreviewIndex(0, 3, -1)).toBe(2)
    expect(nextPreviewIndex(2, 3, 1)).toBe(0)
  })
})
```

- [x] **Step 2: Run the test and verify missing helper failure**

Run: `npm test -- src/tests/image-composer-state.test.ts`

Expected: FAIL because `imageAttachmentState.ts` does not exist.

- [x] **Step 3: Implement ordered imports and preview byte cleanup**

`useImageAttachments` owns:

```ts
interface UseImageAttachmentsResult {
  attachments: ComposerImageAttachment[]
  importing: boolean
  errors: string[]
  addFiles: (files: File[]) => Promise<void>
  removeAttachment: (id: string) => Promise<void>
  replaceAttachments: (attachments: ComposerImageAttachment[]) => void
  clearAcceptedDrafts: () => void
}
```

Implement the pure helpers exactly as:

```ts
export interface ImageSendStateInput {
  text: string
  attachmentCount: number
  importing: boolean
  supportsVision: boolean
}

export function evaluateImageSendState(input: ImageSendStateInput): {
  canSend: boolean
  reason: string | null
} {
  if (input.importing) return { canSend: false, reason: '照片仍在导入' }
  if (input.attachmentCount > 0 && !input.supportsVision) {
    return { canSend: false, reason: '当前模型未启用图片输入' }
  }
  return {
    canSend: Boolean(input.text.trim() || input.attachmentCount > 0),
    reason: null
  }
}

export function nextPreviewIndex(current: number, length: number, delta: -1 | 1): number {
  if (length <= 0) return 0
  return (current + delta + length) % length
}
```

Use these exact component contracts:

```ts
interface ImageAttachmentGridProps {
  attachments: ComposerImageAttachment[]
  mode: 'editable' | 'readonly'
  loadingIds?: Set<string>
  onRemove?: (attachment: ComposerImageAttachment) => void
  onOpen: (index: number) => void
}

interface ImagePreviewModalProps {
  attachments: ComposerImageAttachment[]
  initialIndex: number
  onClose: () => void
}
```

`addFiles` filters `file.type.startsWith('image/')`, reads `arrayBuffer()`, calls `window.api.attachment.importDraft`, and inserts successful results in the original File order even when promises finish out of order. Report one Chinese error per rejected file and keep successful files. Removing a draft calls `discardDrafts`; removing a session attachment from a reverted composer only removes it from composer state.

The grid lazily calls `readPreview(attachment, 'thumbnail')`, creates a Blob URL, and revokes it on replacement/unmount. The modal requests `'original'`, supports Escape, backdrop close, and previous/next buttons using existing icons.

- [x] **Step 4: Integrate the three input methods and send state**

Add a hidden `<input type="file" accept="image/*" multiple>` owned by `PromptArea`; `PlusActionMenu` receives `onAddPhotos` and invokes it from a new image-icon command.

Add `onPaste`, `onDragEnter`, `onDragOver`, `onDragLeave`, and `onDrop` to the prompt card boundary. Prevent default only when the transfer contains image files. Render `ImageAttachmentGrid` above CodeMirror and a non-overlapping drop state within the card.

Pass `attachments` and `clearAcceptedDrafts` into `usePromptEditor`. Its `handleSend` awaits `onSend(text, model, attachments)` and clears both text and attachment state only when the result is `true`. Task 6 already discards accepted draft files, so `clearAcceptedDrafts` only resets Hook state and must not issue a second IPC deletion. Enter sends an image-only message; Shift+Enter remains newline. The button uses `evaluateImageSendState`, a stable `32x32` size, and a `title` containing the blocking reason.

Set `PromptAreaProps.onSend` to `(message: string, modelName: string, attachments: ComposerImageAttachment[]) => Promise<boolean>`. Adapt the existing send hook in `ChatArea/index.tsx` without changing the system-message positional parameter:

```tsx
<PromptArea
  onSend={(message, modelName, attachments) =>
    handleSendMessage(message, modelName, false, attachments)}
  placeholder={activeSessionId ? '随心输入...' : '开始新的对话...'}
  onOpenSettings={() => onOpenSettings('model-config')}
  workspace={workspace}
/>
```

Use `ImagePlus`, `X`, `ChevronLeft`, and `ChevronRight` from `lucide-react` for the new controls, with `title`/`aria-label` on icon-only buttons.

- [x] **Step 5: Run state tests, type checking, and build**

Run: `npm test -- src/tests/image-composer-state.test.ts src/tests/send-message-payload.test.ts`

Run: `npm run typecheck`

Run: `npm run build`

Expected: tests PASS, type checking PASS, and Electron/Vite build succeeds.

- [x] **Step 6: Commit composer UI**

```powershell
git add src/renderer/src/components/PromptArea/hooks/useImageAttachments.ts src/renderer/src/components/chat/imageAttachmentState.ts src/renderer/src/components/chat/ImageAttachmentGrid.tsx src/renderer/src/components/chat/ImageAttachmentGrid.css src/renderer/src/components/chat/ImagePreviewModal.tsx src/renderer/src/components/chat/ImagePreviewModal.css src/renderer/src/components/PromptArea/index.tsx src/renderer/src/components/PromptArea/types.ts src/renderer/src/components/PromptArea/hooks/usePromptEditor.ts src/renderer/src/components/PromptArea/components/PlusActionMenu.tsx src/renderer/src/components/PromptArea/PromptArea.css src/renderer/src/components/chat/ChatArea/index.tsx src/tests/image-composer-state.test.ts
git commit -m "Add image attachments to the prompt composer"
```

---

### Task 8: Chat History Preview, Session Restore, and Revert

**Files:**
- Modify: `src/renderer/src/components/chat/ChatArea/components/ChatMessageList.tsx`
- Modify: `src/renderer/src/App.css`
- Modify: `src/renderer/src/stores/chatStore/types.ts`
- Modify: `src/renderer/src/stores/chatStore/slices/messageSlice.ts`
- Modify: `src/renderer/src/stores/chatStore/slices/sessionSlice.ts`
- Modify: `src/renderer/src/components/PromptArea/index.tsx`
- Modify: `src/renderer/src/components/PromptArea/hooks/usePromptEditor.ts`
- Modify: `src/tests/task-session-restore.test.ts`
- Modify: `src/tests/session-store-runtime.test.ts`

**Interfaces:**
- Consumes: read-only `ImageAttachmentGrid`, `ImagePreviewModal`, and `PendingPromptDraft`.
- Produces: durable log display and attachment-aware revert behavior.

- [x] **Step 1: Add failing restore and revert tests**

Add this persistence case to `session-store-runtime.test.ts`:

```ts
function imageAttachmentFixture() {
  return {
    id: 'img1', kind: 'image' as const, name: 'photo.jpg', mimeType: 'image/jpeg' as const,
    width: 800, height: 600, sizeBytes: 123, storageKey: 'attachment:sessions/s1/img1',
    scope: 'session' as const, sessionId: 's1'
  }
}

it('round-trips image metadata while legacy messages remain valid', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codez-session-'))
  const file = path.join(root, 'sessions.json')
  const store = new SessionStore(file)
  const attachment = imageAttachmentFixture()
  await store.save({
    id: 's1', projectId: 'p1', summary: 'x', relativeTime: 'now',
    messages: [
      { id: 'u1', role: 'user', content: 'inspect', attachments: [attachment] },
      { id: 'a1', role: 'agent', content: 'legacy-compatible' }
    ]
  })
  const reloaded = new SessionStore(file)
  await reloaded.load()
  expect(reloaded.get('s1')?.messages[0].attachments).toEqual([attachment])
  expect(reloaded.get('s1')?.messages[1]).not.toHaveProperty('attachments')
})
```

Add this store-level test to `task-session-restore.test.ts`, using the test's existing dynamic store import and mocked `window.api.session`:

```ts
function imageAttachmentFixture() {
  return {
    id: 'img1', kind: 'image' as const, name: 'photo.jpg', mimeType: 'image/jpeg' as const,
    width: 800, height: 600, sizeBytes: 123, storageKey: 'attachment:sessions/s1/img1',
    scope: 'session' as const, sessionId: 's1'
  }
}

it('revert restores text and images as one pending composer draft', async () => {
  const { useChatStore } = await import('../renderer/src/stores/chatStore')
  const attachment = imageAttachmentFixture()
  const message = { id: 'u1', role: 'user' as const, content: 'inspect', attachments: [attachment] }
  const session = {
    id: 's1', projectId: 'p1', summary: 'x', relativeTime: 'now', messages: [message]
  }
  useChatStore.setState({
    sessions: [session], activeSessionId: 's1', messages: [message], pendingPrompt: null
  } as any)
  await useChatStore.getState().revertToMessage('u1')
  expect(useChatStore.getState().pendingPrompt).toEqual({
    text: 'inspect', attachments: [attachment]
  })
  expect(useChatStore.getState().messages).toEqual([])
  expect(useChatStore.getState().sessions[0].messages).toEqual([])
})
```

The assertions keep the attachment reference in `pendingPrompt` while removing the reverted message from both projections.

- [x] **Step 2: Run restore tests and verify the pending prompt mismatch**

Run: `npm test -- src/tests/task-session-restore.test.ts src/tests/session-store-runtime.test.ts`

Expected: FAIL because revert still stores only a string and session typing drops attachments.

- [x] **Step 3: Render photos in user-message logs**

In `ChatMessageList`, render this inside `.user-message-bubble`:

```tsx
{Boolean(msg.attachments?.length) && (
  <ImageAttachmentGrid
    attachments={msg.attachments!}
    mode="readonly"
    onOpen={(index) => setImagePreview({ attachments: msg.attachments!, index })}
  />
)}
{Boolean(msg.content.trim()) && (
  <MessageBody content={msg.content} onFileClick={handleFileClick} />
)}
```

Mount one `ImagePreviewModal` at list level. Do not create one modal per message. Keep the existing restore button position and message width stable. Add only the minimum bubble width/grid CSS needed; do not nest decorative cards.

- [x] **Step 4: Restore attachments into the composer on revert and session reload**

Change store contracts to `pendingPrompt: PendingPromptDraft | null` and `setPendingPrompt: (prompt: PendingPromptDraft | null) => void`. Change `revertToMessage` to set `{ text: targetMessage.content || '', attachments: targetMessage.attachments || [] }`. In `sessionSlice`, wrap every healed interrupted-subagent string as `{ text: healed.prompt, attachments: [] }` before assigning it.

Remove pending-prompt consumption from `usePromptEditor`. In `PromptArea`, one effect calls `setText(pendingPrompt.text)`, `replaceAttachments(pendingPrompt.attachments)`, restores CodeMirror focus/selection, and only then clears the pending draft. This keeps text and images atomic and avoids competing Hook effects.

Normalize loaded messages with:

```ts
const normalizeMessage = (message: ChatMessage): ChatMessage => ({
  ...message,
  attachments: Array.isArray(message.attachments) ? message.attachments : undefined
})
```

Do not read thumbnails during store hydration; image components load them lazily.

- [x] **Step 5: Run restore tests, type checking, and build**

Run: `npm test -- src/tests/task-session-restore.test.ts src/tests/session-store-runtime.test.ts src/tests/image-composer-state.test.ts`

Run: `npm run typecheck`

Run: `npm run build`

Expected: restore/revert tests PASS, legacy sessions compile, and build succeeds.

- [x] **Step 6: Commit history and revert support**

```powershell
git add src/renderer/src/components/chat/ChatArea/components/ChatMessageList.tsx src/renderer/src/App.css src/renderer/src/stores/chatStore/types.ts src/renderer/src/stores/chatStore/slices/messageSlice.ts src/renderer/src/stores/chatStore/slices/sessionSlice.ts src/renderer/src/components/PromptArea/index.tsx src/renderer/src/components/PromptArea/hooks/usePromptEditor.ts src/tests/task-session-restore.test.ts src/tests/session-store-runtime.test.ts
git commit -m "Show image attachments in chat history"
```

---

### Task 9: Security Regression, Full Verification, and Desktop Acceptance

**Files:**
- Modify: `src/tests/attachment-service.test.ts`
- Modify: `src/tests/image-provider-payload.test.ts`
- Modify: `src/tests/send-message-payload.test.ts`
- Modify: `docs/superpowers/plans/2026-07-11-image-input-and-preview.md` only to check completed boxes during execution.

**Interfaces:**
- Consumes: completed Tasks 1-8.
- Produces: verified release-ready behavior; no new production abstraction.

- [x] **Step 1: Add explicit redaction and containment regressions**

Add tests that:

```ts
it('rejects traversal and keeps persisted metadata free of request bytes', async () => {
  const { service } = await fixture()
  const draft = await service.importDraft({
    name: 'photo.jpg', declaredMimeType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3, 4])
  })
  const [stored] = await service.promoteDrafts('s1', [draft])
  await expect(service.readPreview(
    { ...draft, storageKey: 'attachment:../outside' },
    'original'
  )).rejects.toThrow('Invalid attachment storage key')
  const persistedSession = {
    messages: [{ id: 'u1', role: 'user', content: '', attachments: [stored] }]
  }
  expect(JSON.stringify(persistedSession)).not.toContain('AQIDBA==')
  expect(JSON.stringify(persistedSession)).not.toMatch(/[A-Za-z]:\\/)
})
```

Add a Provider test with two attachments and assert order is `[text, first image, second image]`. Add an image-only OpenAI test that asserts there is no empty text block.

```ts
it('preserves multiple-image order and omits empty text blocks', async () => {
  const first = { ...attachment, id: 'first' }
  const second = { ...attachment, id: 'second' }
  const resolveOrdered = async (item: typeof attachment) => ({
    mimeType: 'image/jpeg' as const,
    dataBase64: item.id === 'first' ? 'FIRST' : 'SECOND'
  })
  const withText = await resolveOpenAIMessages([
    { role: 'user', content: 'inspect', attachments: [first, second] }
  ], resolveOrdered)
  expect(withText[0].content.map((part: any) => part.text || part.image_url.url)).toEqual([
    'inspect', 'data:image/jpeg;base64,FIRST', 'data:image/jpeg;base64,SECOND'
  ])
  const imageOnly = await resolveOpenAIMessages([
    { role: 'user', content: '', attachments: [first] }
  ], resolveOrdered)
  expect(imageOnly[0].content).toEqual([
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,FIRST' } }
  ])
})
```

- [x] **Step 2: Run the complete test suite**

Run: `npm test`

Expected: every Vitest test PASS with no unhandled rejection or open-handle warning.

- [x] **Step 3: Run static and production build verification**

Run: `npm run typecheck`

Run: `npm run build`

Expected: both commands exit 0.

- [ ] **Step 4: Start Electron and perform desktop acceptance**

Run: `npm run dev`

Verify in the actual Electron window:

1. Enable “支持图片输入” for one model and leave it disabled for another.
2. Add one photo by file selection, one by paste, and one by drag/drop; confirm stable thumbnails and original order.
3. Remove one thumbnail, open preview, navigate previous/next, close with Escape, and confirm no overlap at the minimum `800x600` window.
4. Send text + photos and a photo-only message through each configured OpenAI, Anthropic, and Gemini Provider; confirm the model describes visible image content.
5. Switch to the non-vision model with a photo attached; confirm send is blocked with the configured message.
6. Restart CodeZ and reopen the session; confirm history thumbnails and full previews still work.
7. Revert a photo message; confirm text and images return to the composer and can be resent.
8. Move the session to “最近删除”, restore it, and confirm images remain. Permanently delete it and confirm other sessions remain intact.
9. Inspect application and prompt logs for attachment IDs only; confirm there are no Base64 bodies or absolute attachment paths.

- [x] **Step 5: Stop the dev process and commit final regressions**

Stop the Electron dev process cleanly with Ctrl+C, then run:

```powershell
git add src/tests/attachment-service.test.ts src/tests/image-provider-payload.test.ts src/tests/send-message-payload.test.ts docs/superpowers/plans/2026-07-11-image-input-and-preview.md
git commit -m "Verify multimodal image input workflow"
```

---

## Completion Criteria

- Composer displays selected, pasted, and dropped photos directly in the input card.
- Composer and chat history photos open in the same responsive preview modal.
- Image-only and text-plus-image messages persist and restore correctly.
- Main ledger stores attachment references and context budgeting includes image cost.
- OpenAI, Anthropic, and Gemini receive native multimodal image payloads.
- Non-vision models are blocked in Renderer and Main.
- Soft-delete recovery retains photos; permanent deletion and orphan cleanup remove only the correct session data.
- No Base64, raw bytes, or absolute paths appear in session JSON, model ledger, or logs.
- Focused tests, full Vitest, type checking, production build, and Electron desktop acceptance all pass.
