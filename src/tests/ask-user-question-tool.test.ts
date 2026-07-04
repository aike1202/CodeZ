import { describe, it, expect } from 'vitest'
import { validateAskUserRequest, interceptAskUser, AskUserQuestionTool } from '../main/tools/builtin/AskUserQuestionTool'

const validArgs = {
  questions: [{
    question: 'Which lib?', header: 'Lib',
    options: [{ label: 'A' }, { label: 'B' }]
  }]
}

describe('validateAskUserRequest', () => {
  it('1 问 2 选项：ok', () => {
    expect(validateAskUserRequest(validArgs).ok).toBe(true)
  })
  it('5 问：error', () => {
    const qs = Array.from({ length: 5 }, () => ({ question: 'q', header: 'h', options: [{ label: 'a' }, { label: 'b' }] }))
    expect(validateAskUserRequest({ questions: qs }).ok).toBe(false)
  })
  it('0 问：error', () => {
    expect(validateAskUserRequest({ questions: [] }).ok).toBe(false)
  })
  it('options <2：error', () => {
    expect(validateAskUserRequest({ questions: [{ question: 'q', header: 'h', options: [{ label: 'a' }] }] }).ok).toBe(false)
  })
  it('options >4：error', () => {
    const opts = Array.from({ length: 5 }, (_, i) => ({ label: String(i) }))
    expect(validateAskUserRequest({ questions: [{ question: 'q', header: 'h', options: opts }] }).ok).toBe(false)
  })
  it('缺 question：error', () => {
    expect(validateAskUserRequest({ questions: [{ header: 'h', options: [{ label: 'a' }, { label: 'b' }] }] }).ok).toBe(false)
  })
  it('ignoreLabel/submitLabel 合法：保留', () => {
    const r = validateAskUserRequest({ questions: [{ question: 'q', header: 'h', options: [{ label: 'a' }, { label: 'b' }], ignoreLabel: '跳过', submitLabel: '确定' }] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.questions[0].ignoreLabel).toBe('跳过')
  })
  it('ignoreLabel 过长：被剔除', () => {
    const r = validateAskUserRequest({ questions: [{ question: 'q', header: 'h', options: [{ label: 'a' }, { label: 'b' }], ignoreLabel: 'x'.repeat(20) }] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.questions[0].ignoreLabel).toBeUndefined()
  })
  it('submitLabel 空串：被剔除', () => {
    const r = validateAskUserRequest({ questions: [{ question: 'q', header: 'h', options: [{ label: 'a' }, { label: 'b' }], submitLabel: '   ' }] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.questions[0].submitLabel).toBeUndefined()
  })
})

describe('interceptAskUser', () => {
  it('非 AskUserQuestion：handled:false', async () => {
    const r = await interceptAskUser('Read', {}, 'id1', async () => [])
    expect(r.handled).toBe(false)
  })
  it('合法 + handler：返回 answers JSON，isError false', async () => {
    const r = await interceptAskUser('AskUserQuestion', validArgs, 'id1', async () => [{ question: 'Which lib?', answer: 'A' }])
    expect(r.handled).toBe(true)
    expect(r.isError).toBeFalsy()
    const parsed = JSON.parse(r.result!)
    expect(parsed[0].answer).toBe('A')
  })
  it('合法 + 无 handler：error', async () => {
    const r = await interceptAskUser('AskUserQuestion', validArgs, 'id1', null)
    expect(r.handled).toBe(true)
    expect(r.result).toContain('Error:')
  })
  it('非法：error', async () => {
    const r = await interceptAskUser('AskUserQuestion', { questions: [] }, 'id1', async () => [])
    expect(r.result).toContain('Error:')
  })
})

describe('AskUserQuestionTool.execute (直接调用做校验)', () => {
  it('合法：返回 questions 请求载荷', async () => {
    const tool = new AskUserQuestionTool()
    const r = await tool.execute(JSON.stringify(validArgs), { workspaceRoot: '.' })
    const parsed = JSON.parse(r)
    expect(parsed.questions[0].question).toBe('Which lib?')
  })
  it('非法：Error', async () => {
    const tool = new AskUserQuestionTool()
    const r = await tool.execute(JSON.stringify({ questions: [] }), { workspaceRoot: '.' })
    expect(r.startsWith('Error:')).toBe(true)
  })
})
