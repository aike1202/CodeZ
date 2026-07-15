import { randomUUID } from 'crypto'
import type { Tool } from '../Tool'
import { fingerprint } from './canonicalJson'
import { LegacyToolAdapter } from './LegacyToolAdapter'
import { decorateToolHandlerApproval } from './ToolApprovalPolicy'
import type {
  ToolAvailabilityContext,
  ToolCatalogSnapshot,
  ToolHandler
} from './types'

const VALID_TOOL_NAME = /^[A-Za-z0-9_-]+$/

export class ToolRegistry {
  private readonly handlers = new Map<string, ToolHandler>()
  private readonly aliases = new Map<string, string>()

  register(handler: ToolHandler): void {
    const decoratedHandler = decorateToolHandlerApproval(handler)
    const { name, aliases } = decoratedHandler.descriptor
    if (!VALID_TOOL_NAME.test(name)) throw new Error(`Invalid tool name: ${name}`)
    if (this.handlers.has(name) || this.aliases.has(name)) {
      throw new Error(`Tool name already registered: ${name}`)
    }
    for (const alias of aliases) {
      if (!VALID_TOOL_NAME.test(alias)) throw new Error(`Invalid tool alias: ${alias}`)
      if (this.handlers.has(alias) || this.aliases.has(alias) || alias === name) {
        throw new Error(`Tool alias already registered: ${alias}`)
      }
    }
    this.handlers.set(name, decoratedHandler)
    for (const alias of aliases) this.aliases.set(alias, name)
  }

  registerLegacy(tool: Tool): void {
    this.register(new LegacyToolAdapter(tool))
  }

  unregisterSource(sourceId: string): void {
    for (const [name, handler] of this.handlers) {
      if (handler.descriptor.sourceId !== sourceId) continue
      this.handlers.delete(name)
      for (const [alias, canonical] of this.aliases) {
        if (canonical === name) this.aliases.delete(alias)
      }
    }
  }

  resolve(nameOrAlias: string): ToolHandler | undefined {
    const canonical = this.aliases.get(nameOrAlias) || nameOrAlias
    return this.handlers.get(canonical)
  }

  getAllHandlers(): ToolHandler[] {
    return [...this.handlers.values()]
  }

  createSnapshot(context: ToolAvailabilityContext): ToolCatalogSnapshot {
    const handlers = this.getAllHandlers()
      .filter((handler) => {
        const availability = handler.descriptor.availability
        if (!availability.enabled(context)) return false
        if (availability.platforms && !availability.platforms.includes(context.platform)) return false
        return availability.roles === '*' || availability.roles.includes(context.agentRole)
      })
      .sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name))
    const handlersByCanonicalName = new Map(handlers.map((handler) => [handler.descriptor.name, handler]))
    const aliases = new Map(
      [...this.aliases.entries()].filter(([, canonical]) => handlersByCanonicalName.has(canonical))
    )
    const descriptors = handlers.map((handler) => handler.descriptor)
    const catalogFingerprint = fingerprint(descriptors.map((descriptor) => ({
      name: descriptor.name,
      aliases: descriptor.aliases,
      version: descriptor.version,
      source: descriptor.source,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      outputSchema: descriptor.outputSchema,
      exposure: descriptor.availability.exposure
    })))
    return {
      id: `catalog_${catalogFingerprint.slice(0, 16)}_${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      descriptors: Object.freeze([...descriptors]),
      handlersByCanonicalName,
      aliases,
      fingerprint: catalogFingerprint
    }
  }
}
