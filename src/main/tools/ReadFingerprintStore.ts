// src/main/tools/ReadFingerprintStore.ts
export interface ReadSnapshot {
  sha256: string
  buffer: Buffer
  statSignature: string
}

export type ReadSnapshotSource = 'filesystem' | 'shared-cache'

/**
 * 会话内文件快照与交付记录。
 * 快照避免多个 Agent 重复访问文件系统；交付记录保证只有真正收到当前版本
 * 的 Agent scope 才能编辑该文件。
 */
export class ReadFingerprintStore {
  private sessions = new Map<string, Map<string, string>>()
  private snapshots = new Map<string, Map<string, ReadSnapshot>>()
  private deliveries = new Map<string, Map<string, Map<string, string>>>()
  private inflight = new Map<string, Promise<ReadSnapshot>>()

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

  private snapshotBucket(sessionId: string): Map<string, ReadSnapshot> {
    let bucket = this.snapshots.get(sessionId)
    if (!bucket) {
      bucket = new Map()
      this.snapshots.set(sessionId, bucket)
    }
    return bucket
  }

  private deliveryBucket(sessionId: string, contextScopeId: string): Map<string, string> {
    let session = this.deliveries.get(sessionId)
    if (!session) {
      session = new Map()
      this.deliveries.set(sessionId, session)
    }
    let scope = session.get(contextScopeId)
    if (!scope) {
      scope = new Map()
      session.set(contextScopeId, scope)
    }
    return scope
  }

  /** 记录某会话内某文件最新读到的 sha256。 */
  record(sessionId: string, absPath: string, sha256: string): void {
    this.bucket(sessionId).set(this.normalize(absPath), sha256)
  }

  recordSnapshot(sessionId: string, absPath: string, snapshot: ReadSnapshot): void {
    const normalized = this.normalize(absPath)
    this.bucket(sessionId).set(normalized, snapshot.sha256)
    this.snapshotBucket(sessionId).set(normalized, snapshot)
  }

  getSnapshot(sessionId: string, absPath: string, statSignature: string): ReadSnapshot | undefined {
    const snapshot = this.snapshots.get(sessionId)?.get(this.normalize(absPath))
    return snapshot?.statSignature === statSignature ? snapshot : undefined
  }

  async getOrLoadSnapshot(
    sessionId: string,
    absPath: string,
    statSignature: string,
    loader: () => Promise<ReadSnapshot>
  ): Promise<{ snapshot: ReadSnapshot; source: ReadSnapshotSource }> {
    const cached = this.getSnapshot(sessionId, absPath, statSignature)
    if (cached) return { snapshot: cached, source: 'shared-cache' }

    const normalized = this.normalize(absPath)
    const inflightKey = `${sessionId}:${normalized}`
    const existing = this.inflight.get(inflightKey)
    if (existing) return { snapshot: await existing, source: 'shared-cache' }

    const pending = loader().then((snapshot) => {
      this.recordSnapshot(sessionId, absPath, snapshot)
      return snapshot
    })
    this.inflight.set(inflightKey, pending)
    try {
      return { snapshot: await pending, source: 'filesystem' }
    } finally {
      this.inflight.delete(inflightKey)
    }
  }

  recordDelivery(
    sessionId: string,
    contextScopeId: string,
    absPath: string,
    sha256: string
  ): void {
    this.deliveryBucket(sessionId, contextScopeId).set(this.normalize(absPath), sha256)
  }

  hasDelivery(
    sessionId: string,
    contextScopeId: string,
    absPath: string,
    sha256: string
  ): boolean {
    return this.deliveries.get(sessionId)
      ?.get(contextScopeId)
      ?.get(this.normalize(absPath)) === sha256
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
    this.snapshots.delete(sessionId)
    this.deliveries.delete(sessionId)
    const prefix = `${sessionId}:`
    for (const key of this.inflight.keys()) {
      if (key.startsWith(prefix)) this.inflight.delete(key)
    }
  }
}

export function readStatSignature(stat: { size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}

let instance: ReadFingerprintStore | null = null

export function getReadFingerprintStore(): ReadFingerprintStore {
  if (!instance) instance = new ReadFingerprintStore()
  return instance
}
