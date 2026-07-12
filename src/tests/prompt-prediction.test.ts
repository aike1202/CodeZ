import { describe, expect, it } from 'vitest'
import {
  buildPromptPredictionMessages,
  parsePromptPrediction
} from '../main/services/PromptPredictionService'
import {
  canPredictNextPrompt,
  getPromptPredictionSuffix
} from '../renderer/src/components/PromptArea/promptPrediction'
import type { ChatMessage } from '../renderer/src/stores/chatStore'

function message(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `${role}-${content}`, role, content, ...extra }
}

describe('prompt prediction', () => {
  it('parses and normalizes a JSON prediction', () => {
    expect(parsePromptPrediction('```json\n{"suggestion":"继续实现\\n并运行测试"}\n```'))
      .toBe('继续实现 并运行测试')
    expect(parsePromptPrediction('not json')).toBe('')
    expect(parsePromptPrediction('{"suggestion":42}')).toBe('')
  })

  it('treats conversation text as data in the model request', () => {
    const messages = buildPromptPredictionMessages({
      context: [{ role: 'assistant', content: 'Done.' }],
      draft: 'Please '
    })

    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[1].content).toContain('"draft":"Please "')
  })

  it('only predicts after a completed assistant response', () => {
    expect(canPredictNextPrompt([message('user', 'fix it')])).toBe(false)
    expect(canPredictNextPrompt([message('agent', 'done', { streaming: true })])).toBe(false)
    expect(canPredictNextPrompt([message('agent', 'done')])).toBe(true)
    expect(canPredictNextPrompt([message('agent', 'stopped', { interrupted: true })])).toBe(false)
  })

  it('returns only the untyped suffix', () => {
    expect(getPromptPredictionSuffix('', '继续运行测试')).toBe('继续运行测试')
    expect(getPromptPredictionSuffix('继续', '继续运行测试')).toBe('运行测试')
    expect(getPromptPredictionSuffix('Please', 'please run tests')).toBe(' run tests')
    expect(getPromptPredictionSuffix('修复', '运行测试')).toBe('')
  })
})
