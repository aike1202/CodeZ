import { describe, expect, it } from 'vitest'
import { ToolManager } from '../main/tools/ToolManager'

const collaborationTools = [
  'spawn_agent',
  'followup_task',
  'send_message',
  'wait_agent',
  'list_agents',
  'interrupt_agent',
]

describe('Agent collaboration tool catalog', () => {
  it('exposes all collaboration tools to main and only messaging tools to SubAgents', () => {
    const manager = new ToolManager()
    const mainNames = new Set(
      manager.createCatalogSnapshot('main').descriptors.map((tool) => tool.name)
    )
    const exploreNames = new Set(
      manager.createCatalogSnapshot('explore').descriptors.map((tool) => tool.name)
    )

    expect(collaborationTools.every((name) => mainNames.has(name))).toBe(true)
    expect(exploreNames.has('send_message')).toBe(true)
    expect(exploreNames.has('list_agents')).toBe(true)
    expect(exploreNames.has('spawn_agent')).toBe(false)
    expect(exploreNames.has('followup_task')).toBe(false)
    expect(exploreNames.has('wait_agent')).toBe(false)
    expect(exploreNames.has('interrupt_agent')).toBe(false)
  })

  it('classifies collaboration effects without falling back to unknown', async () => {
    const manager = new ToolManager()
    const catalog = manager.createCatalogSnapshot('main')
    const context = {
      workspaceRoot: process.cwd(),
      sessionId: 'session-1',
      agentRole: 'main',
    }
    const inputs: Record<string, Record<string, unknown>> = {
      spawn_agent: { subagent_type: 'Explore' },
      followup_task: { target: '/root/explore_auth' },
      send_message: { target: '/root/explore_auth' },
      wait_agent: {},
      list_agents: {},
      interrupt_agent: { target: '/root/explore_auth' },
    }

    for (const name of collaborationTools) {
      const descriptor = catalog.handlersByCanonicalName.get(name)!.descriptor
      const plan = await descriptor.planEffects(inputs[name], context)
      expect(plan.analysisStatus, name).toBe('parsed')
      expect(plan.effects.some((effect) => effect.kind === 'unknown'), name).toBe(false)
    }
  })
})
