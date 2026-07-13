import { randomUUID } from 'crypto'
import type { ToolDefinition } from '../../../shared/types/provider'
import { fingerprint } from './canonicalJson'
import type {
  ToolDescriptor,
  ToolExposurePlan,
  ToolExposureRequest
} from './types'

function estimateTokens(descriptor: ToolDescriptor): number {
  const chars = descriptor.name.length + descriptor.description.length + JSON.stringify(descriptor.inputSchema).length
  return Math.ceil(chars / 4)
}

export class ToolExposurePlanner {
  plan(request: ToolExposureRequest): ToolExposurePlan {
    const activated = request.activatedDeferredTools || new Set<string>()
    const denied = request.deniedTools || new Set<string>()
    const eager: ToolDescriptor[] = []
    const deferred: ToolDescriptor[] = []
    const hidden: { name: string; reason: string }[] = []

    for (const descriptor of request.catalog.descriptors) {
      const roles = descriptor.availability.roles
      if (roles !== '*' && !roles.includes(request.agentRole)) {
        hidden.push({ name: descriptor.name, reason: 'agent-role' })
        continue
      }
      if (denied.has(descriptor.name)) {
        hidden.push({ name: descriptor.name, reason: 'permission-deny' })
        continue
      }
      if (descriptor.availability.exposure === 'internal') {
        hidden.push({ name: descriptor.name, reason: 'internal' })
        continue
      }
      if (descriptor.availability.exposure === 'deferred' && !activated.has(descriptor.name)) {
        deferred.push(descriptor)
        continue
      }
      eager.push(descriptor)
    }

    const maxTools = request.maxTools ?? Number.POSITIVE_INFINITY
    const tokenBudget = request.schemaTokenBudget ?? Number.POSITIVE_INFINITY
    const prioritized = eager.sort((a, b) => {
      const rank = (item: ToolDescriptor) => item.availability.exposure === 'always' ? 0 : 1
      return rank(a) - rank(b) || a.name.localeCompare(b.name)
    })
    const selected: ToolDescriptor[] = []
    let estimatedSchemaTokens = 0
    for (const descriptor of prioritized) {
      const tokens = estimateTokens(descriptor)
      const mustLoad = descriptor.availability.exposure === 'always'
      if (!mustLoad && (selected.length >= maxTools || estimatedSchemaTokens + tokens > tokenBudget)) {
        deferred.push(descriptor)
        continue
      }
      selected.push(descriptor)
      estimatedSchemaTokens += tokens
    }

    const schemaFingerprint = fingerprint(selected.map((descriptor) => ({
      name: descriptor.name,
      version: descriptor.version,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema
    })))
    return {
      id: `exposure_${schemaFingerprint.slice(0, 16)}_${randomUUID().slice(0, 8)}`,
      catalogSnapshotId: request.catalog.id,
      eagerTools: Object.freeze(selected),
      deferredTools: Object.freeze(deferred
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((descriptor) => ({
          name: descriptor.name,
          summary: descriptor.summary,
          searchHint: descriptor.searchHint
        }))),
      hiddenTools: Object.freeze(hidden),
      schemaFingerprint,
      estimatedSchemaTokens
    }
  }

  toToolDefinitions(plan: ToolExposurePlan): ToolDefinition[] {
    return plan.eagerTools.map((descriptor) => ({
      type: 'function' as const,
      function: {
        name: descriptor.name,
        description: descriptor.description,
        parameters: descriptor.inputSchema
      }
    }))
  }
}

export class ToolExposureState {
  private readonly activatedByScope = new Map<string, Set<string>>()

  get(scopeId: string): ReadonlySet<string> {
    return this.activatedByScope.get(scopeId) || new Set<string>()
  }

  activate(scopeId: string, toolNames: readonly string[]): void {
    const current = this.activatedByScope.get(scopeId) || new Set<string>()
    for (const name of toolNames) current.add(name)
    this.activatedByScope.set(scopeId, current)
  }

  restoreSession(
    sessionId: string,
    activatedByContextScope: Readonly<Record<string, readonly string[]>> | undefined
  ): void {
    if (!activatedByContextScope) return
    for (const [contextScopeId, toolNames] of Object.entries(activatedByContextScope)) {
      this.activate(`${sessionId}:${contextScopeId}`, toolNames)
    }
  }

  clear(scopeId?: string): void {
    if (scopeId) this.activatedByScope.delete(scopeId)
    else this.activatedByScope.clear()
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId}:`
    for (const scopeId of this.activatedByScope.keys()) {
      if (scopeId.startsWith(prefix)) this.activatedByScope.delete(scopeId)
    }
  }
}

const sharedToolExposureState = new ToolExposureState()

export function getToolExposureState(): ToolExposureState {
  return sharedToolExposureState
}
