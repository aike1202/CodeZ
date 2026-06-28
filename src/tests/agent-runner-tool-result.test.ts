import { describe, it, expect } from 'vitest'
import { buildToolError, isToolErrorResult } from '../main/agent/AgentRunner'

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
})
