### Task 1: ReadFingerprintStore（已读去重指纹表）

**Files:**
- Create: `src/main/tools/ReadFingerprintStore.ts`
- Test: `src/tests/read-fingerprint-store.test.ts`

**Interfaces:**
- Consumes: 无（纯内存单例）。
- Produces: `class ReadFingerprintStore` 与 `getReadFingerprintStore()`；方法签名：
  - `record(sessionId: string, absPath: string, sha256: string): void`
  - `isUnchanged(sessionId: string, absPath: string, sha256: string): boolean`
  - `isUnchangedKnown(sessionId: string, absPath: string): boolean`（仅查路径是否已被读过的指纹记录，Task 3 Edit 用）
  - `clear(sessionId: string): void`
  - 内部对 `absPath` 做 `replace(/\\/g,'/').toLowerCase()` 归一化，调用方传原始绝对路径即可。

- [ ] **Step 1: Write the failing test**

```ts
// src/tests/read-fingerprint-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { ReadFingerprintStore, getReadFingerprintStore } from '../main/tools/ReadFingerprintStore'

describe('ReadFingerprintStore', () => {
  let store: ReadFingerprintStore
  const SESSION = 'sess-1'
  const ABS = process.platform === 'win32' ? 'C:/proj/src/a.ts' : '/proj/src/a.ts'

  beforeEach(() => {
    store = new ReadFingerprintStore()
    store.clear(SESSION)
  })

  it('record 后同 sha 的 isUnchanged 返回 true', () => {
    store.record(SESSION, ABS, 'sha-aaa')
    expect(store.isUnchanged(SESSION, ABS, 'sha-aaa')).toBe(true)
  })

  it('不同 sha 的 isUnchanged 返回 false（内容已变）', () => {
    store.record(SESSION, ABS, 'sha-aaa')
    expect(store.isUnchanged(SESSION, ABS, 'sha-bbb')).toBe(false)
  })

  it('isUnchangedKnown：record 前为 false，record 后为 true', () => {
    expect(store.isUnchangedKnown(SESSION, ABS)).toBe(false)
    store.record(SESSION, ABS, 'sha-aaa')
    expect(store.isUnchangedKnown(SESSION, ABS)).toBe(true)
  })

  it('clear 清除该会话所有指纹', () => {
    store.record(SESSION, ABS, 'sha-aaa')
    store.clear(SESSION)
    expect(store.isUnchangedKnown(SESSION, ABS)).toBe(false)
    expect(store.isUnchanged(SESSION, ABS, 'sha-aaa')).toBe(false)
  })

  it('不同 sessionId 互不干扰', () => {
    store.record('sess-1', ABS, 'sha-aaa')
    expect(store.isUnchanged('sess-2', ABS, 'sha-aaa')).toBe(false)
    expect(store.isUnchangedKnown('sess-2', ABS)).toBe(false)
  })

  it('路径归一化：反斜杠/大小写等价', () => {
    const backslash = ABS.replace(/\//g, '\\')
    store.record(SESSION, backslash, 'sha-aaa')
    expect(store.isUnchanged(SESSION, ABS.toUpperCase(), 'sha-aaa')).toBe(true)
  })

  it('getReadFingerprintStore 返回同一单例', () => {
    expect(getReadFingerprintStore()).toBe(getReadFingerprintStore())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/read-fingerprint-store.test.ts`
Expected: FAIL，报 `Cannot find module '../main/tools/ReadFingerprintStore'`。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/tools/ReadFingerprintStore.ts
/**
 * 会话内"已读文件指纹表"单例。
 * 按 sessionId 分桶，记录每个已读文件的绝对路径 -> sha256。
 * Read 工具与 @file 预读路径共同读写，用于"未变即拦截"去重。
 */
export class ReadFingerprintStore {
  private sessions: Map<string, Map<string, string>> = new Map()

  private normalize(absPath: string): string {
    return absPath.replace(/\\/g, '/').toLowerCase()
  }

  private bucket(sessionId: string): Map<string, string> {
    let bucket = this.sessions.get(sessionId)
    if (!bucket) {
      bucket = new Map()
      this.sessions.set(sessionId, bucket)
    }
    return bucket
  }

  /** 记录某会话内某文件最新读到的 sha256。 */
  record(sessionId: string, absPath: string, sha256: string): void {
    this.bucket(sessionId).set(this.normalize(absPath), sha256)
  }

  /** 命中条件：(路径, sha256) 均与上次记录一致 → 视作未变。 */
  isUnchanged(sessionId: string, absPath: string, sha256: string): boolean {
    const bucket = this.sessions.get(sessionId)
    if (!bucket) return false
    return bucket.get(this.normalize(absPath)) === sha256
  }

  /** 仅查路径是否在本会话被读过（不关心内容是否变化）。Edit/Write 用来强制"先 Read"。 */
  isUnchangedKnown(sessionId: string, absPath: string): boolean {
    const bucket = this.sessions.get(sessionId)
    if (!bucket) return false
    return bucket.has(this.normalize(absPath))
  }

  /** 清除某会话的全部指纹（会话结束时调用）。 */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}

let instance: ReadFingerprintStore | null = null

export function getReadFingerprintStore(): ReadFingerprintStore {
  if (!instance) instance = new ReadFingerprintStore()
  return instance
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/read-fingerprint-store.test.ts`
Expected: PASS（7 例全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/ReadFingerprintStore.ts src/tests/read-fingerprint-store.test.ts
git commit -m "feat(tools): add ReadFingerprintStore for session-scoped read dedup"
```
