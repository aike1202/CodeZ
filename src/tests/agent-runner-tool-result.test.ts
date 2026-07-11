import { describe, it, expect, vi } from 'vitest'
import { authorizeToolCall, buildToolError, isToolErrorResult } from '../main/agent/AgentRunner'

describe('AgentRunner tool result helpers', () => {
  it('应识别字符串错误结果', () => {
    expect(isToolErrorResult('Error: Tool not found')).toBe(true)
    expect(isToolErrorResult('Error in apply_patch: failed')).toBe(true)
    expect(isToolErrorResult('Access denied. Cannot modify file outside workspace.')).toBe(true)
    expect(isToolErrorResult('Hash mismatch! Expected a but got b')).toBe(true)
  })

  it('应识别结构化错误结果', () => {
    expect(isToolErrorResult(JSON.stringify({ ok: false, error: 'failed' }))).toBe(true)
    expect(isToolErrorResult(JSON.stringify({ error: { message: 'failed' } }))).toBe(true)
  })

  it('不应误判成功结构化结果', () => {
    expect(isToolErrorResult(JSON.stringify({ changedFiles: ['a.ts'], summary: 'Modified a.ts' }))).toBe(false)
    expect(isToolErrorResult(JSON.stringify({ ok: true, data: 'done' }))).toBe(false)
    expect(isToolErrorResult('plain successful output')).toBe(false)
  })

  it('应为可恢复错误生成 suggestion', () => {
    const hashError = buildToolError('Error: Hash mismatch! Please call read_files again.')
    expect(hashError.code).toBe('RECOVERABLE_TOOL_ERROR')
    expect(hashError.recoverable).toBe(true)
    expect(hashError.suggestion).toContain('Re-read')

    const fatalError = buildToolError('Error: Tool execution denied by security policy.')
    expect(fatalError.code).toBe('TOOL_ERROR')
    expect(fatalError.recoverable).toBe(false)
    expect(fatalError.suggestion).toBeUndefined()
  })

  it.each(['SubAgentRunner', 'DelegateTasks'])(
    '特殊工具 %s 没有审批处理器时 fail-closed',
    async (toolName) => {
      const result = await authorizeToolCall(toolName, {}, '/tmp/codez-workspace')

      expect(result.allowed).toBe(false)
      expect(result.error).toContain('No approval handler registered')
    }
  )

  it.each(['SubAgentRunner', 'DelegateTasks'])(
    '特殊工具 %s 仅在用户明确批准后放行',
    async (toolName) => {
      const approve = vi.fn().mockResolvedValue(true)
      const result = await authorizeToolCall(toolName, { task: 'test' }, '/tmp/codez-workspace', approve)

      expect(result.allowed).toBe(true)
      expect(approve).toHaveBeenCalledOnce()
      expect(approve.mock.calls[0][0]).toMatchObject({ toolName, args: { task: 'test' } })
    }
  )

  it('passes the active session id into permission requests', async () => {
    const approve = vi.fn().mockResolvedValue(true)
    const result = await authorizeToolCall('WebFetch', { url: 'https://example.test' }, '/tmp/codez-workspace', approve, null, 'session-a')

    expect(result.allowed).toBe(true)
    expect(approve.mock.calls[0][0]).toMatchObject({ sessionId: 'session-a' })
  })
})
