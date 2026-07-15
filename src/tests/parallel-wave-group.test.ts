import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParallelExecState } from '../renderer/src/stores/parallelExecStore'
import { ParallelWaveGroup } from '../renderer/src/components/chat/ParallelWaveGroup'

type ParallelViewState = Pick<
  ParallelExecState,
  'active' | 'sessionId' | 'planSlug' | 'isolation' | 'rationale' | 'waves' | 'overallStatus'
>

const parallelState = vi.hoisted<ParallelViewState>(() => ({
  active: false,
  sessionId: null,
  planSlug: null,
  isolation: null,
  rationale: '',
  waves: [],
  overallStatus: null
}))

const chatState = vi.hoisted(() => ({ activeSessionId: 'session-current' as string | null }))

vi.mock('../renderer/src/stores/parallelExecStore', () => ({
  useParallelExecStore: () => parallelState
}))

vi.mock('../renderer/src/stores/chatStore', () => ({
  useChatStore: (selector: (state: typeof chatState) => unknown) => selector(chatState)
}))

describe('ParallelWaveGroup capsule', () => {
  beforeEach(() => {
    parallelState.active = false
    parallelState.sessionId = null
    parallelState.planSlug = null
    parallelState.isolation = null
    parallelState.rationale = ''
    parallelState.waves = []
    parallelState.overallStatus = null
    chatState.activeSessionId = 'session-current'
  })

  it('stays hidden when no parallel execution is active', () => {
    expect(renderToStaticMarkup(React.createElement(ParallelWaveGroup))).toBe('')
  })

  it('renders a collapsed capsule with current progress', () => {
    parallelState.active = true
    parallelState.sessionId = 'session-current'
    parallelState.planSlug = 'tauri-baseline'
    parallelState.overallStatus = 'running'
    parallelState.waves = [{
      index: 0,
      stepIds: ['t1', 't2'],
      status: 'in_progress',
      stepResults: [{
        stepId: 't1',
        status: 'completed',
        summary: 'done',
        filesModified: []
      }]
    }]

    const html = renderToStaticMarkup(React.createElement(ParallelWaveGroup))

    expect(html).toContain('pwg-capsule')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('并行执行：tauri-baseline')
    expect(html).toContain('执行中 1/2')
    expect(html).not.toContain('pwg-panel')
  })

  it('shows the completed count in its capsule summary', () => {
    parallelState.active = true
    parallelState.sessionId = 'session-current'
    parallelState.overallStatus = 'completed'
    parallelState.waves = [{
      index: 0,
      stepIds: ['t1'],
      status: 'completed',
      stepResults: [{
        stepId: 't1',
        status: 'completed',
        summary: 'done',
        filesModified: ['src/main.ts']
      }]
    }]

    const html = renderToStaticMarkup(React.createElement(ParallelWaveGroup))

    expect(html).toContain('pwg-capsule--completed')
    expect(html).toContain('已完成 1/1')
  })

  it('stays hidden when the parallel execution belongs to another session', () => {
    parallelState.active = true
    parallelState.sessionId = 'session-previous'
    parallelState.overallStatus = 'halted'
    parallelState.waves = [{
      index: 0,
      stepIds: ['t1'],
      status: 'failed',
      stepResults: [{
        stepId: 't1',
        status: 'failed',
        summary: 'failed in the previous session',
        filesModified: []
      }]
    }]

    expect(renderToStaticMarkup(React.createElement(ParallelWaveGroup))).toBe('')
  })
})
