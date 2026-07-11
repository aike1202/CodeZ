import type {
  ExecutionLogDisplayItem,
  ParallelToolBatchItem,
  UnifiedTimelineItem
} from './types'

function getBatchStatus(items: UnifiedTimelineItem[]): ParallelToolBatchItem['status'] {
  if (items.some((item) => item.status === 'running')) return 'running'
  if (items.some((item) => item.status === 'error')) return 'error'
  return 'success'
}

export function groupParallelToolBatches(
  items: UnifiedTimelineItem[]
): ExecutionLogDisplayItem[] {
  const result: ExecutionLogDisplayItem[] = []
  const emittedBatchIds = new Set<string>()

  items.forEach((item) => {
    if (!item.batchId || !item.batchSize || item.batchSize < 2) {
      result.push(item)
      return
    }

    if (emittedBatchIds.has(item.batchId)) return
    emittedBatchIds.add(item.batchId)

    const batchItems = items
      .filter((candidate) => candidate.batchId === item.batchId)
      .sort((left, right) =>
        (left.batchIndex ?? Number.MAX_SAFE_INTEGER) -
        (right.batchIndex ?? Number.MAX_SAFE_INTEGER)
      )

    result.push({
      id: item.batchId,
      type: 'parallel-batch',
      batchId: item.batchId,
      batchSize: batchItems.length,
      batchKind: item.batchKind ?? 'tools',
      timestamp: Math.min(...batchItems.map((candidate) => candidate.timestamp)),
      status: getBatchStatus(batchItems),
      items: batchItems
    })
  })

  return result
}

export function getParallelBatchDuration(
  batch: ParallelToolBatchItem,
  now = Date.now()
): number {
  const startedAt = Math.min(...batch.items.map((item) => item.timestamp))
  const completedAt = Math.max(
    ...batch.items.map((item) =>
      item.status === 'running' ? now : (item.completedAt ?? item.timestamp)
    )
  )

  return Math.max(completedAt - startedAt, 0)
}
