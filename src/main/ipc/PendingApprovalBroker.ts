export type PendingApprovalCancellation = () => void

export class PendingApprovalBroker {
  private readonly byStream = new Map<string, Set<PendingApprovalCancellation>>()

  register(streamId: string, cancel: PendingApprovalCancellation): () => void {
    const pending = this.byStream.get(streamId) ?? new Set<PendingApprovalCancellation>()
    pending.add(cancel)
    this.byStream.set(streamId, pending)
    return () => {
      const current = this.byStream.get(streamId)
      if (!current) return
      current.delete(cancel)
      if (current.size === 0) this.byStream.delete(streamId)
    }
  }

  denyAll(streamId: string): void {
    const pending = this.byStream.get(streamId)
    if (!pending) return
    this.byStream.delete(streamId)
    for (const cancel of [...pending]) cancel()
  }

  count(streamId: string): number {
    return this.byStream.get(streamId)?.size ?? 0
  }
}
