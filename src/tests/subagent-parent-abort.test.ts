import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '../shared/types/provider'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'

const chatMock = vi.hoisted(() => ({
  streamChat: vi.fn()
}))

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  chatMock.streamChat.mockReset()
})

vi.mock('../main/services/ChatService', () => ({
  ChatService: vi.fn().mockImplementation(() => ({
    streamChat: chatMock.streamChat
  }))
}))

describe('SubAgentManager parent abort propagation', { timeout: 15_000 }, () => {
  it('returns interrupted and removes the session handle when the parent aborts', async () => {
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')

    SubAgentManager.register({
      type: 'ParentAbortTest',
      description: 'Parent abort test agent',
      whenToUse: 'test',
      maxLoops: 2,
      getTools: (): ToolDefinition[] => [],
      systemPromptBuilder: () => 'test subagent'
    })

    chatMock.streamChat.mockImplementationOnce(async (_config, callbacks) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      callbacks.onChunk('should not complete', '', undefined)
      callbacks.onDone('should not complete')
    })

    const changedSessions: string[] = []
    const unsubscribe = SubAgentManager.onActiveChange((sessionId) => changedSessions.push(sessionId))
    const parent = new AbortController()
    const resultPromise = SubAgentManager.spawn(
      'ParentAbortTest',
      {
        workspaceRoot: process.cwd(),
        sessionId: 'parent-abort-session',
        task: 'wait for parent abort',
        parentPrompt: 'wait for parent abort',
        subAgentId: 'subagent-parent-abort',
        parentSignal: parent.signal,
        apiConfig: {
          baseUrl: 'https://example.invalid',
          apiKey: 'key',
          apiFormat: 'openai',
          model: 'test-model'
        },
        contextCapabilities: { contextWindowTokens: 65_536, maxOutputTokens: 4_096 }
      },
      {
        onChunk: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn()
      }
    )

    await vi.waitFor(() => {
      expect(SubAgentManager.listActiveForSession('parent-abort-session')).toEqual([
        'subagent-parent-abort'
      ])
    })
    parent.abort('The user changed the task requirements.')

    const result = await resultPromise
    expect(result.status).toBe('interrupted')
    expect(result.output).toContain('interrupted')
    expect(result.handoff).toMatchObject({
      reasonCode: 'parent_interrupted',
      reason: 'The user changed the task requirements.',
      originalTask: 'wait for parent abort',
      canResume: true
    })
    expect(SubAgentManager.listActiveForSession('parent-abort-session')).toEqual([])
    expect(changedSessions).toEqual(['parent-abort-session', 'parent-abort-session'])
    unsubscribe()
  })

  it('hands modified files and recent tool outcomes back to the parent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-subagent-handoff-'))
    dirs.push(root)
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    const writeTool: ToolDefinition = {
      type: 'function',
      function: { name: 'Write', description: 'Write a file', parameters: {} }
    }
    SubAgentManager.register({
      type: 'ParentAbortWriteTest',
      description: 'Parent abort write test agent',
      whenToUse: 'test',
      maxLoops: 3,
      getTools: () => [writeTool],
      systemPromptBuilder: () => 'test subagent'
    })

    chatMock.streamChat.mockImplementationOnce(async (_config, callbacks) => {
      callbacks.onChunk('I created the implementation file.', '')
      callbacks.onChunk('', '', [{
        index: 0,
        id: 'write-1',
        type: 'function',
        function: {
          name: 'Write',
          arguments: JSON.stringify({ file_path: 'src/handoff.ts', content: 'export const done = true\n' })
        }
      }])
      callbacks.onDone('', 'tool_calls')
    })

    const parent = new AbortController()
    const toolEnd = vi.fn(() => {
      parent.abort('The user stopped the parent after the file was created.')
    })
    const resultPromise = SubAgentManager.spawn('ParentAbortWriteTest', {
      workspaceRoot: root,
      sessionId: 'parent-abort-write-session',
      task: 'implement the handoff bridge',
      parentPrompt: 'implement the handoff bridge',
      context: 'The parent already completed the design.',
      scope: { directories: ['src'] },
      permissionScope: { allowedWriteFiles: ['src/handoff.ts'] },
      subAgentId: 'subagent-parent-abort-write',
      parentSignal: parent.signal,
      apiConfig: {
        baseUrl: 'https://example.invalid', apiKey: 'key', apiFormat: 'openai', model: 'test-model'
      },
      contextCapabilities: { contextWindowTokens: 65_536, maxOutputTokens: 4_096 }
    }, {
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onPermissionRequest: vi.fn(async () => true),
      onSubAgentToolEnd: toolEnd
    })

    const result = await resultPromise

    expect(toolEnd).toHaveBeenCalledWith(
      'subagent-parent-abort-write', 'write-1', expect.any(String)
    )
    expect(result.status).toBe('interrupted')
    expect(result.handoff).toMatchObject({
      reasonCode: 'parent_interrupted',
      reason: 'The user stopped the parent after the file was created.',
      originalTask: 'implement the handoff bridge',
      knownContext: 'The parent already completed the design.',
      scope: { directories: ['src'] },
      filesModified: ['src/handoff.ts'],
      recentTools: [expect.objectContaining({
        name: 'Write', status: 'success', target: 'src/handoff.ts'
      })],
      canResume: true
    })
  })

  it('does not report a failed read as an examined file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-subagent-read-handoff-'))
    dirs.push(root)
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src', 'existing.ts'), 'export const existing = true\n', 'utf8')
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    const readTool: ToolDefinition = {
      type: 'function',
      function: { name: 'Read', description: 'Read a file', parameters: {} }
    }
    SubAgentManager.register({
      type: 'ParentAbortReadFailureTest',
      description: 'Parent abort failed read test agent',
      whenToUse: 'test',
      maxLoops: 2,
      getTools: () => [readTool],
      systemPromptBuilder: () => 'test subagent'
    })
    chatMock.streamChat.mockImplementationOnce(async (_config, callbacks) => {
      callbacks.onChunk('', '', [{
        index: 0,
        id: 'read-missing',
        type: 'function',
        function: {
          name: 'Read',
          arguments: JSON.stringify({ files: [
            { file_path: 'src/existing.ts' },
            { file_path: 'src/missing.ts' }
          ] })
        }
      }])
      callbacks.onDone('', 'tool_calls')
    })

    const parent = new AbortController()
    const resultPromise = SubAgentManager.spawn('ParentAbortReadFailureTest', {
      workspaceRoot: root,
      sessionId: 'parent-abort-read-session',
      task: 'inspect the missing file',
      parentPrompt: 'inspect the missing file',
      subAgentId: 'subagent-parent-abort-read',
      parentSignal: parent.signal,
      apiConfig: {
        baseUrl: 'https://example.invalid', apiKey: 'key', apiFormat: 'openai', model: 'test-model'
      },
      contextCapabilities: { contextWindowTokens: 65_536, maxOutputTokens: 4_096 }
    }, {
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onSubAgentToolEnd: vi.fn(() => parent.abort('Stop after the failed read.'))
    })

    const result = await resultPromise
    expect(result.handoff).toMatchObject({
      filesExamined: ['src/existing.ts'],
      recentTools: [expect.objectContaining({
        name: 'Read', status: 'error'
      })]
    })
  })
})
