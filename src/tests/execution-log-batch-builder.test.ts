import { describe, expect, it } from 'vitest'
import type {
  ParallelToolBatchItem,
  UnifiedTimelineItem
} from '../renderer/src/components/chat/ExecutionLog/utils/types'
import {
  buildUnifiedTimeline,
  getParallelBatchDuration,
  groupParallelToolBatches
} from '../renderer/src/components/chat/ExecutionLog/utils'
import type { ExecutionTimelineItem } from '../renderer/src/stores/chatStore'

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

  it('uses the visible child count for an expanded batch', () => {
    const [batch] = groupParallelToolBatches([
      toolItem('one', 100, { batchId: 'batch-count', batchIndex: 0, batchSize: 2 }),
      toolItem('two', 101, { batchId: 'batch-count', batchIndex: 0, batchSize: 2 }),
      toolItem('three', 102, { batchId: 'batch-count', batchIndex: 1, batchSize: 2 })
    ])

    expect((batch as ParallelToolBatchItem).batchSize).toBe(3)
  })

  it('expands a multi-file Read into a read batch', () => {
    const timeline: ExecutionTimelineItem[] = [{
      id: 'tool_read-1',
      type: 'tool',
      toolCall: {
        id: 'read-1',
        name: 'Read',
        args: JSON.stringify({
          files: [
            { file_path: 'src/App.tsx' },
            { file_path: 'src/db.ts', offset: 10, limit: 20 }
          ]
        }),
        status: 'success',
        result: [
          '<file path="src/App.tsx">',
          '1\tcontent',
          '</file>',
          '',
          '<file path="src/db.ts">',
          'Error: File not found.',
          '</file>'
        ].join('\n'),
        startedAt: 100,
        completedAt: 250,
        sequence: 0
      },
      startedAt: 100,
      updatedAt: 250,
      sequence: 0
    }]

    const unified = buildUnifiedTimeline(timeline, [], [], undefined, false)
    const [batch] = groupParallelToolBatches(unified)

    expect(batch.type).toBe('parallel-batch')
    expect((batch as ParallelToolBatchItem).batchKind).toBe('read')
    expect((batch as ParallelToolBatchItem).items.map((item) => item.realPath)).toEqual([
      'src/App.tsx',
      'src/db.ts'
    ])
    expect((batch as ParallelToolBatchItem).items[1].target).toContain('#L10-29')
    expect((batch as ParallelToolBatchItem).items[1].status).toBe('error')
    expect((batch as ParallelToolBatchItem).status).toBe('error')
  })
})
