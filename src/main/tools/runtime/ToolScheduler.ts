import type { PreparedToolCall, ToolExecutionWave } from './types'

function resourceBase(key: string): string {
  return key.replace(/:(read|write)$/, '')
}

function conflicts(a: PreparedToolCall, b: PreparedToolCall): boolean {
  if (a.handler.descriptor.behavior.concurrency === 'exclusive') return true
  if (b.handler.descriptor.behavior.concurrency === 'exclusive') return true
  for (const left of a.resourceKeys) {
    for (const right of b.resourceKeys) {
      if (resourceBase(left) !== resourceBase(right)) continue
      if (left.endsWith(':read') && right.endsWith(':read')) continue
      return true
    }
  }
  return false
}

export class ToolScheduler {
  plan(calls: readonly PreparedToolCall[]): ToolExecutionWave[] {
    const waves: ToolExecutionWave[] = []
    const placed: Array<{ call: PreparedToolCall; waveIndex: number }> = []
    for (const call of [...calls].sort((a, b) => a.call.position - b.call.position)) {
      const exclusive = call.handler.descriptor.behavior.concurrency === 'exclusive'
      let waveIndex = exclusive ? waves.length : 0
      for (const previous of placed) {
        if (conflicts(previous.call, call)) {
          waveIndex = Math.max(waveIndex, previous.waveIndex + 1)
        }
      }
      while (waves.length <= waveIndex) {
        waves.push({
          index: waves.length,
          calls: [],
          reason: 'independent'
        })
      }
      ;(waves[waveIndex].calls as PreparedToolCall[]).push(call)
      waves[waveIndex].reason = exclusive
        ? 'exclusive'
        : waveIndex === 0
          ? 'independent'
          : 'resource-serialized'
      placed.push({ call, waveIndex })
    }
    return waves
  }
}
