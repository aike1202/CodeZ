import { describe, expect, it } from 'vitest'
import { ToolManager } from '../main/tools/ToolManager'
import { fingerprint } from '../main/tools/runtime/canonicalJson'
import schemaGolden from './fixtures/migration/tool-schema-golden.json'

const V1_TOOL_NAMES = [...schemaGolden.canonicalToolNames].sort((a, b) => a.localeCompare(b))

describe('V1/V2 tool schema baseline', () => {
  it('locks the approval-aware 24-tool canonical schema fingerprint', () => {
    const manager = new ToolManager()
    const baseline = manager.createCatalogSnapshot().descriptors
      .filter((descriptor) => V1_TOOL_NAMES.includes(descriptor.name))
      .map((descriptor) => ({
        name: descriptor.name,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    expect(baseline.map((item) => item.name)).toEqual(V1_TOOL_NAMES)
    expect(fingerprint(baseline)).toBe(schemaGolden.canonicalSchemaSha256)
  })

  it('records a comparable default eager-schema budget', () => {
    const manager = new ToolManager()
    const catalog = manager.createCatalogSnapshot()
    const v1Bytes = Buffer.byteLength(JSON.stringify(catalog.descriptors
      .filter((descriptor) => V1_TOOL_NAMES.includes(descriptor.name))
      .map((descriptor) => ({ name: descriptor.name, description: descriptor.description, inputSchema: descriptor.inputSchema }))), 'utf8')
    const plan = manager.createExposurePlan({ catalog })
    const v2Bytes = Buffer.byteLength(JSON.stringify(plan.eagerTools.map((descriptor) => ({
      name: descriptor.name, description: descriptor.description, inputSchema: descriptor.inputSchema
    }))), 'utf8')
    expect({ v1Bytes, v2Bytes, reduction: 1 - v2Bytes / v1Bytes }).toMatchObject({
      v1Bytes: expect.any(Number), v2Bytes: expect.any(Number), reduction: expect.any(Number)
    })
    expect(v2Bytes).toBeLessThan(v1Bytes)
    expect(1 - v2Bytes / v1Bytes).toBeGreaterThanOrEqual(schemaGolden.minimumDeferredSchemaReduction)
  })

  it('exposes session skill lifecycle tools while retaining the legacy Skill tool', () => {
    const names = new Set(new ToolManager().createCatalogSnapshot().descriptors.map((tool) => tool.name))
    expect(schemaGolden.requiredSessionLifecycleTools.every((name) => names.has(name))).toBe(true)
  })
})
