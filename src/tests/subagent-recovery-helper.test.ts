import { describe, expect, it } from 'vitest'
import {
  isRecoverableProviderError,
  shouldRetryAfterUserMaintenance,
} from '../main/agent/AgentRunner/subagentRecoveryHelper'

describe('isRecoverableProviderError', () => {
  it('treats network and timeout errors as recoverable', () => {
    expect(isRecoverableProviderError('网络错误: fetch failed')).toBe(true)
    expect(isRecoverableProviderError('等待首个响应超时，请检查网络 / Provider / 模型是否可用。')).toBe(true)
  })

  it('treats provider maintenance errors as recoverable by the user', () => {
    expect(isRecoverableProviderError('鉴权失败 (401): 请检查 API Key')).toBe(true)
    expect(isRecoverableProviderError('请求失败 (429): rate limit exceeded')).toBe(true)
    expect(isRecoverableProviderError('模型或端点不存在 (404)')).toBe(true)
    expect(isRecoverableProviderError('insufficient quota')).toBe(true)
  })

  it('does not treat ordinary schema/tool errors as provider recovery cases', () => {
    expect(isRecoverableProviderError('submit_result data did not match the expected schema')).toBe(false)
    expect(isRecoverableProviderError('Write denied: path escapes the workspace')).toBe(false)
  })
})

describe('shouldRetryAfterUserMaintenance', () => {
  it('continues when the user chooses the continue option', () => {
    expect(
      shouldRetryAfterUserMaintenance([
        { question: 'Worker 遇到 API/网络问题。', answer: '已修复，继续重试' },
      ])
    ).toBe(true)
  })

  it('stops when the user chooses stop or ignores the question', () => {
    expect(
      shouldRetryAfterUserMaintenance([
        { question: 'Worker 遇到 API/网络问题。', answer: '停止这个 Worker' },
      ])
    ).toBe(false)
    expect(
      shouldRetryAfterUserMaintenance([
        { question: 'Worker 遇到 API/网络问题。', answer: '__IGNORED__' },
      ])
    ).toBe(false)
  })
})
