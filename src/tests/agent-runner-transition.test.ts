import { describe, expect, it } from 'vitest'
import { resolveAgentTransition } from '../main/agent/AgentRunner'
import { TransitionEvent } from '../main/agent/AgentRunner/LoopStateMachine'

describe('AgentRunner transition resolution', () => {
  it('completes when the assistant stops despite pending tasks', () => {
    const transition = resolveAgentTransition({
      toolCallCount: 0,
      isVerificationFailure: false,
      verificationRetryCount: 0,
      maxVerificationRetries: 3,
      consecutiveIdleTurns: 0,
      stopReason: 'stop',
      hasPendingTasks: true,
      assistantContent: '请确认一下：代码是否在别的目录？'
    })

    expect(transition).toBe(TransitionEvent.Completed)
  })

  it('does not auto-continue pending work when the assistant stops', () => {
    const transition = resolveAgentTransition({
      toolCallCount: 0,
      isVerificationFailure: false,
      verificationRetryCount: 0,
      maxVerificationRetries: 3,
      consecutiveIdleTurns: 0,
      stopReason: 'stop',
      hasPendingTasks: true,
      assistantContent: '我会继续检查当前工作区附近查找项目文件。'
    })

    expect(transition).toBe(TransitionEvent.Completed)
  })

  it('continues after tool execution to let the model consume tool results', () => {
    const transition = resolveAgentTransition({
      toolCallCount: 1,
      isVerificationFailure: false,
      verificationRetryCount: 0,
      maxVerificationRetries: 3,
      consecutiveIdleTurns: 0,
      stopReason: 'tool_calls',
      hasPendingTasks: true,
      assistantContent: '下一个关键问题：任务数据要怎么保存？\n\n你选哪一种？'
    })

    expect(transition).toBe(TransitionEvent.ToolExecuted)
  })

  it('completes truncated output instead of injecting an auto-continue prompt', () => {
    const transition = resolveAgentTransition({
      toolCallCount: 0,
      isVerificationFailure: false,
      verificationRetryCount: 0,
      maxVerificationRetries: 3,
      consecutiveIdleTurns: 0,
      stopReason: 'length',
      hasPendingTasks: true,
      assistantContent: 'partial response'
    })

    expect(transition).toBe(TransitionEvent.Completed)
  })
})
