// src/main/tools/ReadFingerprintStore.ts
import * as path from 'path'
import type { FileContextReference } from '../../shared/types/context'
import { canonicalMutationPath } from './FileMutationCoordinator'
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
  private snapshotOrder = new Map<string, { sessionId: string; path: string }>()
  private snapshotBytes = 0
  private deliveries = new Map<string, Map<string, Map<string, string>>>()
  private inflight = new Map<string, Promise<ReadSnapshot>>()

  constructor(
    private readonly maxSnapshotEntries = 100,
    private readonly maxSnapshotBytes = 25 * 1024 * 1024
  ) {}

  private normalize(absPath: string): string {
    return canonicalMutationPath(path.normalize(absPath))
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
    const snapshots = this.snapshotBucket(sessionId)
    const previous = snapshots.get(normalized)
    if (previous) this.snapshotBytes -= previous.buffer.byteLength
    snapshots.set(normalized, snapshot)
    this.snapshotBytes += snapshot.buffer.byteLength
    this.touchSnapshot(sessionId, normalized)
    this.evictSnapshots()
  }

  getSnapshot(sessionId: string, absPath: string, statSignature: string): ReadSnapshot | undefined {
    const normalized = this.normalize(absPath)
    const snapshot = this.snapshots.get(sessionId)?.get(normalized)
    if (snapshot?.statSignature !== statSignature) return undefined
    this.touchSnapshot(sessionId, normalized)
    return snapshot
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
    const inflightKey = `${sessionId}:${normalized}:${statSignature}`
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

  /** Replace one scope's edit authorization from the model-visible context projection. */
  replaceScopeDeliveries(
    sessionId: string,
    contextScopeId: string,
    messages: ReadonlyArray<{
      fileReferences?: readonly FileContextReference[]
      sourceSequence?: number
    }>
  ): void {
    const session = this.deliveries.get(sessionId)
    session?.delete(contextScopeId)

    const latest = new Map<string, FileContextReference>()
    const usableVersions = new Set<string>()
    const orderedMessages = messages
      .map((message, index) => ({ message, index }))
      .sort((left, right) =>
        (left.message.sourceSequence ?? Number.MIN_SAFE_INTEGER) -
          (right.message.sourceSequence ?? Number.MIN_SAFE_INTEGER) ||
        left.index - right.index
      )
    for (const { message } of orderedMessages) {
      for (const reference of message.fileReferences || []) {
        const normalized = this.normalize(reference.path)
        latest.set(normalized, reference)
        if (reference.contentIncluded || reference.operation === 'edit' || reference.operation === 'write') {
          usableVersions.add(`${normalized}:${reference.sha256}`)
        }
      }
    }

    for (const [normalized, reference] of latest) {
      if (usableVersions.has(`${normalized}:${reference.sha256}`)) {
        this.deliveryBucket(sessionId, contextScopeId).set(normalized, reference.sha256)
      }
    }
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
    const snapshots = this.snapshots.get(sessionId)
    if (snapshots) {
      for (const [normalized, snapshot] of snapshots) {
        this.snapshotBytes -= snapshot.buffer.byteLength
        this.snapshotOrder.delete(this.snapshotKey(sessionId, normalized))
      }
      this.snapshots.delete(sessionId)
    }
    this.deliveries.delete(sessionId)
    const prefix = `${sessionId}:`
    for (const key of this.inflight.keys()) {
      if (key.startsWith(prefix)) this.inflight.delete(key)
    }
  }

  private snapshotKey(sessionId: string, normalizedPath: string): string {
    return `${sessionId}\0${normalizedPath}`
  }

  private touchSnapshot(sessionId: string, normalizedPath: string): void {
    const key = this.snapshotKey(sessionId, normalizedPath)
    this.snapshotOrder.delete(key)
    this.snapshotOrder.set(key, { sessionId, path: normalizedPath })
  }

  private evictSnapshots(): void {
    while (
      this.snapshotOrder.size > Math.max(0, this.maxSnapshotEntries) ||
      this.snapshotBytes > Math.max(0, this.maxSnapshotBytes)
    ) {
      const oldest = this.snapshotOrder.entries().next().value as
        | [string, { sessionId: string; path: string }]
        | undefined
      if (!oldest) break
      const [key, entry] = oldest
      this.snapshotOrder.delete(key)
      const bucket = this.snapshots.get(entry.sessionId)
      const snapshot = bucket?.get(entry.path)
      if (!snapshot) continue
      this.snapshotBytes -= snapshot.buffer.byteLength
      bucket!.delete(entry.path)
      if (bucket!.size === 0) this.snapshots.delete(entry.sessionId)
    }
    this.snapshotBytes = Math.max(0, this.snapshotBytes)
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
