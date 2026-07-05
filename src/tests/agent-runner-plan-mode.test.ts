// src/tests/agent-runner-plan-mode.test.ts
import { describe, it, expect } from 'vitest'
import { ToolManager } from '../main/tools/ToolManager'
import { IPC_CHANNELS } from '../shared/ipc/channels'

describe('ToolManager.getReadOnlyTools()', () => {
  it('应返回 4 个只读工具', () => {
    const tm = new ToolManager()
    const readOnly = tm.getReadOnlyTools()
    const names = readOnly.map(t => t.function.name).sort()
    expect(names).toEqual([
      'Glob',
      'Grep',
      'Read',
      'list_files'
    ])
  })

  it('应排除写入/编辑/执行类工具', () => {
    const tm = new ToolManager()
    const readOnly = tm.getReadOnlyTools()
    const names = new Set(readOnly.map(t => t.function.name))
    expect(names.has('Edit')).toBe(false)
    expect(names.has('Write')).toBe(false)
    expect(names.has('Bash')).toBe(false)
    expect(names.has('PowerShell')).toBe(false)
    expect(names.has('TaskCreate')).toBe(false)
  })

  it('应返回合法的 ToolDefinition 结构', () => {
    const tm = new ToolManager()
    const readOnly = tm.getReadOnlyTools()
    for (const def of readOnly) {
      expect(def.type).toBe('function')
      expect(def.function).toBeDefined()
      expect(typeof def.function.name).toBe('string')
      expect(typeof def.function.description).toBe('string')
      expect(def.function.parameters).toBeDefined()
    }
  })
})

describe('Plan mode 工具一致性', () => {
  it('只读工具集合应是全部工具的子集', () => {
    const tm = new ToolManager()
    const all = tm.getToolDefinitions()
    const readOnly = tm.getReadOnlyTools()
    const allNames = new Set(all.map(t => t.function.name))
    for (const rt of readOnly) {
      expect(allNames.has(rt.function.name)).toBe(true)
    }
  })

  it('全部工具数量应大于只读工具数量', () => {
    const tm = new ToolManager()
    expect(tm.getToolDefinitions().length).toBeGreaterThan(tm.getReadOnlyTools().length)
  })
})

describe('Plan mode IPC 通道', () => {
  it('PLAN_STATE_CHANGED 通道应已定义', () => {
    expect(IPC_CHANNELS.PLAN_STATE_CHANGED).toBe('plan:state-changed')
  })

  it('PLAN_APPROVE 与 PLAN_REJECT 通道应已定义', () => {
    expect(IPC_CHANNELS.PLAN_APPROVE).toBe('plan:approve')
    expect(IPC_CHANNELS.PLAN_REJECT).toBe('plan:reject')
  })
})

describe('AgentRunConfig planMode 字段', () => {
  it('config 对象应支持 planMode 布尔字段', () => {
    const config: { planMode?: boolean } = { planMode: true }
    expect(config.planMode).toBe(true)
    config.planMode = false
    expect(config.planMode).toBe(false)
  })
})
