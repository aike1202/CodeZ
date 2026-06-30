import { describe, it, expect } from 'vitest'
import { ContextManager } from '../main/agent/ContextManager'

describe('ContextManager.truncateToolOutput', () => {
  it('短内容原样返回', () => {
    expect(ContextManager.truncateToolOutput('short', 1000)).toBe('short')
  })

  it('{ok:true,data} 超限：切片 data 头尾，保持 ok:true（不丢弃）', () => {
    const big = 'A'.repeat(5000)
    const wrapped = JSON.stringify({ ok: true, data: big })
    const result = ContextManager.truncateToolOutput(wrapped, 1000)
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(typeof parsed.data).toBe('string')
    expect(parsed.data).toContain('[System Note: Tool output truncated')
    expect(parsed.data.startsWith('A')).toBe(true)
    expect(parsed.data.endsWith('A')).toBe(true)
    expect(parsed.data.length).toBeLessThan(big.length)
  })

  it('{ok:false,error} 不被截断改写（错误信息原样保留）', () => {
    const err = JSON.stringify({ ok: false, error: { code: 'X', message: 'fail' } })
    // 即便"超限"也不截断错误
    const result = ContextManager.truncateToolOutput(err + ' '.repeat(2000), 100)
    // 错误包装原样返回
    expect(result).toBe(err + ' '.repeat(2000))
  })

  it('非 JSON 字符串超限：头尾切片 + 提示', () => {
    const big = 'X'.repeat(5000)
    const result = ContextManager.truncateToolOutput(big, 1000)
    expect(result).toContain('[System Note: Tool output truncated')
    expect(result.startsWith('X')).toBe(true)
    expect(result.endsWith('X')).toBe(true)
    expect(result.length).toBeLessThan(big.length)
  })
})

describe('ContextManager.trimMessages — tool 输出红线下限', () => {
  it('32K 窗口下 maxToolOutput 下限为 45000（覆盖 Read 40000 上限）', () => {
    // 构造一条 42000 字符的 {ok:true,data} tool 消息：旧 15000 红线会截断，新 45000 不会
    const data = 'L'.repeat(42000)
    const toolMsg: any = {
      role: 'tool',
      tool_call_id: 'tc1',
      name: 'Read',
      content: JSON.stringify({ ok: true, data })
    }
    const result = ContextManager.trimMessages([toolMsg], 32000)
    const parsed = JSON.parse(result.messages[0].content as string)
    expect(parsed.ok).toBe(true)
    // 42000 < 45000 下限 → 不应被截断
    expect(parsed.data).toBe(data)
  })
})
