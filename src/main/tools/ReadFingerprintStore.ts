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
