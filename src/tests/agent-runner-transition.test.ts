import { describe, expect, it } from 'vitest'
import { resolveAgentTransition, updateConsecutiveIdleTurns } from '../main/agent/AgentRunner'
import { TransitionEvent } from '../main/agent/AgentRunner/LoopStateMachine'

describe('AgentRunner transition resolution', () => {
  it.each(['stop', 'length'] as const)('continues active tasks after a text-only %s response', (stopReason) => {
    const transition = resolveAgentTransition({
      toolCallCount: 0,
      isVerificationFailure: false,
      verificationRetryCount: 0,
      maxVerificationRetries: 3,
      consecutiveIdleTurns: 1,
      stopReason,
      hasPendingTasks: true,
      assistantContent: '继续处理剩余任务。'
    })

    expect(transition).toBe(TransitionEvent.SchedulerContinue)
  })

  it('completes a text-only response when no active task remains', () => {
    const transition = resolveAgentTransition({
      toolCallCount: 0,
      isVerificationFailure: false,
      verificationRetryCount: 0,
      maxVerificationRetries: 3,
      consecutiveIdleTurns: 0,
      stopReason: 'stop',
      hasPendingTasks: false,
      assistantContent: '全部完成。'
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

  it('pauses after three unchanged idle turns with active tasks', () => {
    const transition = resolveAgentTransition({
      toolCallCount: 0,
      isVerificationFailure: false,
      verificationRetryCount: 0,
      maxVerificationRetries: 3,
      consecutiveIdleTurns: 3,
      stopReason: 'stop',
      hasPendingTasks: true,
      assistantContent: '仍在处理。'
    })

    expect(transition).toBe(TransitionEvent.MaxIdleReached)
  })

  it('pauses when the repeated tool failure guard is reached', () => {
    const transition = resolveAgentTransition({
      toolCallCount: 1,
      isVerificationFailure: false,
      verificationRetryCount: 0,
      maxVerificationRetries: 3,
      consecutiveIdleTurns: 0,
      repeatedFailureLimitReached: true,
      hasPendingTasks: true
    })

    expect(transition).toBe(TransitionEvent.RepeatedFailure)
  })

  it('keeps verification retries ahead of active-task continuation', () => {
    const transition = resolveAgentTransition({
      toolCallCount: 0,
      isVerificationFailure: true,
      verificationRetryCount: 1,
      maxVerificationRetries: 3,
      consecutiveIdleTurns: 1,
      hasPendingTasks: true
    })

    expect(transition).toBe(TransitionEvent.RetryRequested)
  })
})

describe('AgentRunner idle progress tracking', () => {
  it('counts text-only turns with unchanged active tasks', () => {
    expect(updateConsecutiveIdleTurns({
      previous: 1,
      toolCallCount: 0,
      hasPendingTasks: true,
      taskStatusChanged: false,
      hadSuccessfulToolExecution: false
    })).toBe(2)
  })

  it.each([
    { taskStatusChanged: true, hadSuccessfulToolExecution: false, hasPendingTasks: true },
    { taskStatusChanged: false, hadSuccessfulToolExecution: true, hasPendingTasks: true },
    { taskStatusChanged: false, hadSuccessfulToolExecution: false, hasPendingTasks: false }
  ])('resets idle turns when observable progress occurs (%o)', (progress) => {
    expect(updateConsecutiveIdleTurns({
      previous: 2,
      toolCallCount: progress.hadSuccessfulToolExecution ? 1 : 0,
      ...progress
    })).toBe(0)
  })
})
