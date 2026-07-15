import { describe, expect, it } from 'vitest'
import { ToolScheduler } from '../main/tools/runtime/ToolScheduler'
import type { PreparedToolCall, ToolHandler } from '../main/tools/runtime/types'

function call(position: number, key: string, concurrency: 'safe' | 'resource-locked' | 'exclusive' = 'resource-locked'): PreparedToolCall {
  const handler = {
    descriptor: {
      name: `T${position}`,
      behavior: { concurrency }
    }
  } as unknown as ToolHandler
  return {
    call: { callId: `c${position}`, position, name: `T${position}`, rawArguments: '{}' },
    handler,
    input: {},
    approvalPreference: null,
    effects: { effects: [], analysisStatus: 'parsed' },
    resourceKeys: key ? [key] : []
  }
}

describe('ToolScheduler', () => {
  it('runs independent calls in the same wave', () => {
    const waves = new ToolScheduler().plan([call(0, 'file:a:read'), call(1, 'file:b:write')])
    expect(waves).toHaveLength(1)
    expect(waves[0].calls).toHaveLength(2)
  })

  it('serializes conflicting writes while allowing read/read', () => {
    const scheduler = new ToolScheduler()
    expect(scheduler.plan([call(0, 'file:a:read'), call(1, 'file:a:read')])).toHaveLength(1)
    const writes = scheduler.plan([call(0, 'file:a:write'), call(1, 'file:a:write')])
    expect(writes).toHaveLength(2)
    expect(writes[0].calls[0].call.position).toBe(0)
    expect(writes[1].calls[0].call.position).toBe(1)
  })

  it('does not let later calls jump ahead of an exclusive call', () => {
    const waves = new ToolScheduler().plan([
      call(0, '', 'exclusive'),
      call(1, 'file:a:read', 'safe')
    ])
    expect(waves).toHaveLength(2)
    expect(waves[1].calls[0].call.position).toBe(1)
  })
})
