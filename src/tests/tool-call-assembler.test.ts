import { describe, expect, it } from 'vitest'
import { ToolCallAssembler } from '../main/tools/runtime/ToolCallAssembler'

describe('ToolCallAssembler', () => {
  it('assembles interleaved streaming fragments in position order', () => {
    const assembler = new ToolCallAssembler('turn_1')
    assembler.push({ provider: 'openai', position: 1, callId: 'b', nameDelta: 'Wr', argumentsDelta: '{"x":' })
    assembler.push({ provider: 'openai', position: 0, callId: 'a', nameDelta: 'Re', argumentsDelta: '{"f":' })
    assembler.push({ provider: 'openai', position: 1, nameDelta: 'ite', argumentsDelta: '1}', isFinal: true })
    assembler.push({ provider: 'openai', position: 0, nameDelta: 'ad', argumentsDelta: '2}', isFinal: true })
    expect(assembler.finalize({ requireFinal: true })).toEqual([
      { callId: 'a', position: 0, name: 'Read', rawArguments: '{"f":2}', thoughtSignature: undefined },
      { callId: 'b', position: 1, name: 'Write', rawArguments: '{"x":1}', thoughtSignature: undefined }
    ])
  })

  it('normalizes Gemini object arguments', () => {
    const assembler = new ToolCallAssembler('turn_2')
    assembler.push({
      provider: 'gemini', position: 0, nameDelta: 'Glob', completeArguments: { pattern: '**/*.ts' }, isFinal: true
    })
    expect(assembler.finalize()[0]).toMatchObject({
      callId: 'turn_2_0',
      name: 'Glob',
      rawArguments: '{"pattern":"**/*.ts"}'
    })
  })
})

