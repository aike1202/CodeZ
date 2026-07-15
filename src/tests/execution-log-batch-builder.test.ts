import { describe, expect, it } from 'vitest'
import type {
  ParallelToolBatchItem,
  UnifiedTimelineItem
} from '../renderer/src/components/chat/ExecutionLog/utils/types'
import {
  buildEditItems,
  buildUnifiedTimeline,
  formatRunningDuration,
  getParallelBatchDuration,
  groupParallelToolBatches
} from '../renderer/src/components/chat/ExecutionLog/utils'
import type { ExecutionTimelineItem } from '../renderer/src/stores/chatStore'
import { parseTaskUpdateDetail } from '../renderer/src/components/chat/ExecutionLogDetail/taskUpdateDetail'

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

describe('execution log running duration', () => {
  it('formats live elapsed time for short and long operations', () => {
    expect(formatRunningDuration(999)).toBe('<1s')
    expect(formatRunningDuration(46_900)).toBe('46s')
    expect(formatRunningDuration(65_000)).toBe('1m 05s')
  })
})

describe('execution log parallel batch builder', () => {
  it('hides ToolSearch schema-loading operations from the default timeline', () => {
    const timeline: ExecutionTimelineItem[] = [{
      id: 'tool_search-skill',
      type: 'tool',
      toolCall: {
        id: 'search-skill',
        name: 'ToolSearch',
        args: JSON.stringify({ query: 'select:Skill', max_results: 5 }),
        status: 'success',
        result: JSON.stringify({ activated: ['Skill'], availableNextTurn: true }),
        startedAt: 100,
        completedAt: 200,
        sequence: 0
      },
      startedAt: 100,
      updatedAt: 200,
      sequence: 0
    }]

    expect(buildUnifiedTimeline(timeline, [], [], undefined, false)).toEqual([])
  })

  it('does not leave a one-item parallel batch after hiding ToolSearch', () => {
    const timeline: ExecutionTimelineItem[] = [
      {
        id: 'tool_search-web',
        type: 'tool',
        toolCall: {
          id: 'search-web',
          name: 'ToolSearch',
          args: JSON.stringify({ query: 'select:WebSearch' }),
          status: 'success',
          result: JSON.stringify({ activated: ['WebSearch'] }),
          startedAt: 100,
          completedAt: 200,
          sequence: 0,
          batchId: 'batch-with-search',
          batchIndex: 0,
          batchSize: 2
        },
        startedAt: 100,
        updatedAt: 200,
        sequence: 0
      },
      {
        id: 'tool_task-get-visible',
        type: 'tool',
        toolCall: {
          id: 'task-get-visible',
          name: 'TaskGet',
          args: JSON.stringify({ taskId: 't1' }),
          status: 'success',
          result: '{}',
          startedAt: 101,
          completedAt: 201,
          sequence: 1,
          batchId: 'batch-with-search',
          batchIndex: 1,
          batchSize: 2
        },
        startedAt: 101,
        updatedAt: 201,
        sequence: 1
      }
    ]

    const visible = buildUnifiedTimeline(timeline, [], [], undefined, false)
    expect(groupParallelToolBatches(visible)).toEqual(visible)
    expect(visible).toMatchObject([{ toolName: 'TaskGet' }])
  })

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

  it('groups consecutive directory browsing records into a compact batch', () => {
    const first = toolItem('glob-a', 100, {
      verb: 'Explored',
      toolName: 'Glob',
      detail: 'No files matched.'
    })
    const second = toolItem('glob-b', 101, {
      verb: 'Explored',
      toolName: 'list_files',
      detail: 'src/App.tsx'
    })
    const read = toolItem('read-a', 102, { verb: 'Analyzed', toolName: 'Read' })
    const third = toolItem('glob-c', 103, { verb: 'Explored', toolName: 'list_dir' })

    const grouped = groupParallelToolBatches([first, second, read, third])

    expect(grouped).toHaveLength(3)
    expect(grouped[0]).toMatchObject({
      type: 'parallel-batch',
      batchKind: 'explore',
      batchSize: 2
    })
    expect((grouped[0] as ParallelToolBatchItem).items).toEqual([first, second])
    expect(grouped[1]).toBe(read)
    expect(grouped[2]).toBe(third)
  })

  it('keeps active and non-directory browsing records separate', () => {
    const complete = toolItem('glob-complete', 100, { verb: 'Explored', toolName: 'Glob' })
    const active = toolItem('glob-active', 101, {
      status: 'running',
      verb: 'Exploring',
      toolName: 'Glob'
    })
    const unrelated = toolItem('other-explore', 102, {
      verb: 'Explored',
      toolName: 'OtherTool'
    })

    expect(groupParallelToolBatches([complete, active, unrelated])).toEqual([
      complete,
      active,
      unrelated
    ])
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
    expect((batch as ParallelToolBatchItem).items.map((item) => item.target)).toEqual([
      'App.tsx',
      'db.ts #L10-29'
    ])
    expect((batch as ParallelToolBatchItem).items[1].status).toBe('error')
    expect((batch as ParallelToolBatchItem).status).toBe('error')
  })

  it('shows only the file name for a single Read while preserving its full path', () => {
    const filePath = 'F:\\Project\\src\\timelineBuilder.ts'
    const timeline: ExecutionTimelineItem[] = [{
      id: 'tool_read-single',
      type: 'tool',
      toolCall: {
        id: 'read-single',
        name: 'Read',
        args: JSON.stringify({ files: [{ file_path: filePath, offset: 10, limit: 20 }] }),
        status: 'success',
        result: `<file path="${filePath}">\n10\tcontent\n</file>`,
        startedAt: 100,
        completedAt: 200,
        sequence: 0
      },
      startedAt: 100,
      updatedAt: 200,
      sequence: 0
    }]

    expect(buildUnifiedTimeline(timeline, [], [], undefined, false)).toMatchObject([{
      target: 'timelineBuilder.ts #L10-29',
      realPath: filePath,
      fileName: 'timelineBuilder.ts'
    }])
  })

  it('counts a multi-file Read as one item inside an outer tool batch', () => {
    const timeline: ExecutionTimelineItem[] = [
      {
        id: 'tool_read-outer',
        type: 'tool',
        toolCall: {
          id: 'read-outer',
          name: 'Read',
          args: JSON.stringify({
            files: [
              { file_path: 'src/a.ts' },
              { file_path: 'src/b.ts' }
            ]
          }),
          status: 'success',
          result: '',
          startedAt: 100,
          completedAt: 200,
          sequence: 0,
          batchId: 'tools-1',
          batchIndex: 0,
          batchSize: 2
        },
        startedAt: 100,
        updatedAt: 200,
        sequence: 0
      },
      {
        id: 'tool_task-get',
        type: 'tool',
        toolCall: {
          id: 'task-get',
          name: 'TaskGet',
          args: JSON.stringify({ taskId: 't1' }),
          status: 'success',
          result: '{}',
          startedAt: 101,
          completedAt: 210,
          sequence: 1,
          batchId: 'tools-1',
          batchIndex: 1,
          batchSize: 2
        },
        startedAt: 101,
        updatedAt: 210,
        sequence: 1
      }
    ]

    const [batch] = groupParallelToolBatches(
      buildUnifiedTimeline(timeline, [], [], undefined, false)
    )

    expect(batch.type).toBe('parallel-batch')
    expect((batch as ParallelToolBatchItem).batchKind).toBe('tools')
    expect((batch as ParallelToolBatchItem).batchSize).toBe(2)
    expect((batch as ParallelToolBatchItem).items.map((item) => item.target)).toEqual([
      '2 个文件',
      'TaskGet'
    ])
  })
})

describe('legacy edit execution log', () => {
  it('shows only the file name for Edit while preserving its full path', () => {
    const filePath = 'F:\\Project\\src\\components\\App.tsx'
    const timeline: ExecutionTimelineItem[] = [{
      id: 'tool_edit-modern',
      type: 'tool',
      toolCall: {
        id: 'edit-modern',
        name: 'Edit',
        args: JSON.stringify({
          file_path: filePath,
          edits: [{ old_string: 'before', new_string: 'after' }]
        }),
        status: 'success',
        result: 'Updated successfully.',
        startedAt: 100,
        completedAt: 200,
        sequence: 0
      },
      startedAt: 100,
      updatedAt: 200,
      sequence: 0
    }]

    expect(buildUnifiedTimeline(timeline, [], [], undefined, false)).toMatchObject([{
      target: 'App.tsx',
      realPath: filePath,
      fileName: 'App.tsx',
      verb: 'Edited'
    }])
  })

  it('keeps distinct diff metadata for repeated edits to the same file', () => {
    const filePath = 'src/components/App.tsx'
    const edits = buildEditItems([
      { id: 'legacy-edit-1', type: 'edit', title: `已编辑 ${filePath}`, detail: '+1 -1', timestamp: 100 },
      { id: 'legacy-edit-2', type: 'edit', title: `已编辑 ${filePath}`, detail: '+2 -2', timestamp: 101 }
    ], [
      { id: 'tool-edit-1', name: 'Edit', args: JSON.stringify({ file_path: filePath, edits: [{ old_string: 'a', new_string: 'b' }] }), status: 'success', startedAt: 100, sequence: 0 },
      { id: 'tool-edit-2', name: 'Edit', args: JSON.stringify({ file_path: filePath, edits: [{ old_string: 'c', new_string: 'd' }] }), status: 'success', startedAt: 101, sequence: 1 }
    ])

    const items = buildUnifiedTimeline([], [], edits, undefined, false)

    expect(items).toMatchObject([
      { target: 'App.tsx', realPath: filePath, toolName: 'Edit', args: expect.stringContaining('"new_string":"b"') },
      { target: 'App.tsx', realPath: filePath, toolName: 'Edit', args: expect.stringContaining('"new_string":"d"') }
    ])
  })
})

const taskUpdateTimeline = (status: 'completed' | 'cancelled'): ExecutionTimelineItem[] => [{
  id: `tool_task-${status}`,
  type: 'tool',
  toolCall: {
    id: `task-${status}`,
    name: 'TaskUpdate',
    args: JSON.stringify({ taskId: 't1', status }),
    status: 'success',
    result: JSON.stringify({
      ok: true,
      data: {
        task: {
          id: 't1',
          subject: 'Lifecycle task',
          description: 'Detailed terminal snapshot',
          status,
          files: ['src/task.ts'],
          acceptanceCriteria: ['Terminal state is logged'],
          verificationCommand: 'npm test'
        },
        summary: '1/1 completed'
      }
    }),
    startedAt: 100,
    completedAt: 200,
    sequence: 0
  },
  startedAt: 100,
  updatedAt: 200,
  sequence: 0
}]

describe('TaskUpdate execution log', () => {
  it.each([
    ['completed', '完成任务：Lifecycle task'],
    ['cancelled', '取消任务：Lifecycle task']
  ] as const)('keeps a %s TaskUpdate as a terminal execution log', (status, target) => {
    const [item] = buildUnifiedTimeline(taskUpdateTimeline(status), [], [], undefined, false)
    expect(item).toMatchObject({ toolName: 'TaskUpdate', target, status: 'success' })
  })

  it('derives one TaskUpdate terminal log per completed delegated task', () => {
    const timeline: ExecutionTimelineItem[] = [{
      id: 'tool_delegate',
      type: 'tool',
      toolCall: {
        id: 'delegate',
        name: 'DelegateTasks',
        args: JSON.stringify({ waves: [{ index: 0, taskIds: ['t1'] }] }),
        status: 'success',
        result: JSON.stringify({
          ok: true,
          data: {
            source: 'task:s1',
            status: 'completed',
            waves: [],
            terminalTasks: [{
              id: 't1',
              subject: 'Delegated task',
              description: 'Completed by a Worker',
              status: 'completed',
              files: ['src/delegated.ts'],
              acceptanceCriteria: ['Worker result is retained'],
              verificationCommand: 'npm test'
            }]
          }
        }),
        startedAt: 100,
        completedAt: 200,
        sequence: 0
      },
      startedAt: 100,
      updatedAt: 200,
      sequence: 0
    }]

    const items = buildUnifiedTimeline(timeline, [], [], undefined, false)
    const terminalItem = items.find((item) => item.id === 'delegate_task_t1')

    expect(terminalItem).toMatchObject({
      toolName: 'TaskUpdate',
      target: '完成任务：Delegated task',
      status: 'success'
    })
    expect(parseTaskUpdateDetail(terminalItem?.detail)).toMatchObject({
      task: {
        id: 't1',
        description: 'Completed by a Worker',
        files: ['src/delegated.ts']
      }
    })
  })

  it('parses complete TaskUpdate detail and tolerates legacy reduced snapshots', () => {
    const [fullItem] = buildUnifiedTimeline(taskUpdateTimeline('completed'), [], [], undefined, false)
    expect(parseTaskUpdateDetail(fullItem.detail)).toMatchObject({
      task: {
        description: 'Detailed terminal snapshot',
        files: ['src/task.ts'],
        acceptanceCriteria: ['Terminal state is logged'],
        verificationCommand: 'npm test'
      }
    })

    expect(parseTaskUpdateDetail(JSON.stringify({
      ok: true,
      data: { task: { id: 't1', subject: 'Legacy', status: 'completed' } }
    }))).toMatchObject({ task: { subject: 'Legacy', status: 'completed' } })
  })

  it('drops malformed optional Task fields before structured rendering', () => {
    const parsed = parseTaskUpdateDetail(JSON.stringify({
      ok: true,
      data: {
        task: {
          id: 't1',
          subject: 'Legacy',
          status: 'unknown',
          files: 'src/task.ts',
          acceptanceCriteria: [1, 2],
          verificationCommand: false
        }
      }
    }))

    expect(parsed?.task).toMatchObject({ id: 't1', subject: 'Legacy' })
    expect(parsed?.task.status).toBeUndefined()
    expect(parsed?.task.files).toBeUndefined()
    expect(parsed?.task.acceptanceCriteria).toBeUndefined()
    expect(parsed?.task.verificationCommand).toBeUndefined()
  })
})
