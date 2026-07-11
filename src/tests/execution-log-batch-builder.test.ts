import { describe, expect, it } from 'vitest'
import type {
  ParallelToolBatchItem,
  UnifiedTimelineItem
} from '../renderer/src/components/chat/ExecutionLog/utils/types'
import {
  getParallelBatchDuration,
  groupParallelToolBatches
} from '../renderer/src/components/chat/ExecutionLog/utils/batchBuilder'

const toolItem = (
  id: string,
  timestamp: number,
  options: Partial<UnifiedTimelineItem> = {}
): UnifiedTimelineItem => ({
  id,
  type: 'tool',
  timestamp,
  completedAt: timestamp + 100,
  status: 'success',
  verb: 'Analyzed',
  target: id,
  ...options
})

describe('execution log parallel batch builder', () => {
  it('groups one model response into one parallel batch', () => {
    const items = [
      toolItem('read-a', 100, { batchId: 'batch-1', batchIndex: 0, batchSize: 4 }),
      toolItem('search-b', 101, { batchId: 'batch-1', batchIndex: 1, batchSize: 4 }),
      toolItem('edit-c', 102, {
        type: 'edit',
        verb: 'Edited',
        batchId: 'batch-1',
        batchIndex: 2,
        batchSize: 4
      }),
      toolItem('command-d', 103, {
        type: 'command',
        verb: 'Terminal',
        batchId: 'batch-1',
        batchIndex: 3,
        batchSize: 4
      })
    ]

    const grouped = groupParallelToolBatches(items)

    expect(grouped).toHaveLength(1)
    expect(grouped[0].type).toBe('parallel-batch')
    expect((grouped[0] as ParallelToolBatchItem).items.map((item) => item.id)).toEqual([
      'read-a',
      'search-b',
      'edit-c',
      'command-d'
    ])
  })

  it('keeps single and legacy items ungrouped', () => {
    const legacy = toolItem('legacy', 100)
    const single = toolItem('single', 200, {
      batchId: 'single-batch',
      batchIndex: 0,
      batchSize: 1
    })

    expect(groupParallelToolBatches([legacy, single])).toEqual([legacy, single])
  })

  it('preserves batchIndex ordering', () => {
    const grouped = groupParallelToolBatches([
      toolItem('second', 100, { batchId: 'batch-2', batchIndex: 1, batchSize: 2 }),
      toolItem('first', 101, { batchId: 'batch-2', batchIndex: 0, batchSize: 2 })
    ])

    expect((grouped[0] as ParallelToolBatchItem).items.map((item) => item.id)).toEqual([
      'first',
      'second'
    ])
  })

  it('computes duration from earliest start to latest completion', () => {
    const [batch] = groupParallelToolBatches([
      toolItem('fast', 100, {
        completedAt: 250,
        batchId: 'batch-3',
        batchIndex: 0,
        batchSize: 2
      }),
      toolItem('slow', 120, {
        completedAt: 500,
        batchId: 'batch-3',
        batchIndex: 1,
        batchSize: 2
      })
    ])

    expect(getParallelBatchDuration(batch as ParallelToolBatchItem)).toBe(400)
  })

  it('uses the current time while any child is still running', () => {
    const [batch] = groupParallelToolBatches([
      toolItem('running', 100, {
        status: 'running',
        batchId: 'batch-running',
        batchIndex: 0,
        batchSize: 2
      }),
      toolItem('done', 120, {
        completedAt: 200,
        batchId: 'batch-running',
        batchIndex: 1,
        batchSize: 2
      })
    ])

    expect((batch as ParallelToolBatchItem).status).toBe('running')
    expect(getParallelBatchDuration(batch as ParallelToolBatchItem, 400)).toBe(300)
  })

  it('marks a completed batch as error when any child fails', () => {
    const [batch] = groupParallelToolBatches([
      toolItem('ok', 100, { batchId: 'batch-4', batchIndex: 0, batchSize: 2 }),
      toolItem('failed', 101, {
        status: 'error',
        batchId: 'batch-4',
        batchIndex: 1,
        batchSize: 2
      })
    ])

    expect((batch as ParallelToolBatchItem).status).toBe('error')
  })
})
