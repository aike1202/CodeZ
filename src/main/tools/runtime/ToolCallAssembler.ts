import type { NormalizedToolCall, ToolCallFragment } from './types'

interface AccumulatedCall {
  callId: string
  name: string
  arguments: string
  thoughtSignature?: string
  complete: boolean
}

export class ToolCallAssembler {
  private readonly calls = new Map<number, AccumulatedCall>()

  constructor(private readonly idPrefix: string) {}

  push(fragment: ToolCallFragment): void {
    const current = this.calls.get(fragment.position) || {
      callId: fragment.callId || `${this.idPrefix}_${fragment.position}`,
      name: '',
      arguments: '',
      complete: false
    }
    if (fragment.callId) current.callId = fragment.callId
    if (fragment.nameDelta) current.name += fragment.nameDelta
    if (fragment.completeArguments !== undefined) {
      current.arguments = JSON.stringify(fragment.completeArguments)
    } else if (fragment.argumentsDelta) {
      current.arguments += fragment.argumentsDelta
    }
    if (fragment.thoughtSignature) current.thoughtSignature = fragment.thoughtSignature
    if (fragment.isFinal) current.complete = true
    this.calls.set(fragment.position, current)
  }

  finalize(options: { requireFinal?: boolean } = {}): NormalizedToolCall[] {
    const requireFinal = options.requireFinal ?? false
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, value]) => !requireFinal || value.complete)
      .map(([position, value]) => ({
        callId: value.callId,
        position,
        name: value.name,
        rawArguments: value.arguments || '{}',
        thoughtSignature: value.thoughtSignature
      }))
  }

  reset(): void {
    this.calls.clear()
  }
}

