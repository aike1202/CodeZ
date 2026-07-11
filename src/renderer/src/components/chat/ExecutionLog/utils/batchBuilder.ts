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

function isExploreItem(item: UnifiedTimelineItem): boolean {
  return item.type === 'tool' &&
    item.verb === 'Explored' &&
    (item.toolName === 'Glob' || item.toolName === 'list_files' || item.toolName === 'list_dir') &&
    !item.batchId
}

function buildExploreBatch(items: UnifiedTimelineItem[]): ParallelToolBatchItem {
  return {
    id: `explore_batch_${items[0].id}`,
    type: 'parallel-batch',
    batchId: `explore_batch_${items[0].id}`,
    batchSize: items.length,
    batchKind: 'explore',
    timestamp: items[0].timestamp,
    status: getBatchStatus(items),
    items
  }
}

export function groupParallelToolBatches(
  items: UnifiedTimelineItem[]
): ExecutionLogDisplayItem[] {
  const result: ExecutionLogDisplayItem[] = []
  const emittedBatchIds = new Set<string>()

  for (let index = 0; index < items.length;) {
    const item = items[index]

    if (isExploreItem(item)) {
      const exploreItems = [item]
      index += 1

      while (index < items.length && isExploreItem(items[index])) {
        exploreItems.push(items[index])
        index += 1
      }

      result.push(exploreItems.length === 1 ? item : buildExploreBatch(exploreItems))
      continue
    }

    if (!item.batchId || !item.batchSize || item.batchSize < 2) {
      result.push(item)
      index += 1
      continue
    }

    if (emittedBatchIds.has(item.batchId)) {
      index += 1
      continue
    }
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
    index += 1
  }

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
