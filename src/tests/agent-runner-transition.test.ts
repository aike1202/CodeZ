import { describe, expect, it } from 'vitest'
import { resolveAgentTransition } from '../main/agent/AgentRunner'
import {
  AgentState,
  LoopStateMachine,
  TransitionEvent
} from '../main/agent/AgentRunner/LoopStateMachine'
import agentStateGolden from './fixtures/migration/agent-state-golden.json'

describe('Agent state migration golden', () => {
  it.each(agentStateGolden.transitions)(
    'transitions from $from with $event to $to',
    ({ from, event, to }) => {
      expect(LoopStateMachine.next(from as AgentState, event as TransitionEvent)).toBe(to)
    }
  )
})

describe('AgentRunner transition resolution', () => {
  it('completes a text-only response', () => {
    const transition = resolveAgentTransition({
      toolCallCount: 0,
      isVerificationFailure: false,
      verificationRetryCount: 0,
      maxVerificationRetries: 3,
      stopReason: 'stop',
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
      stopReason: 'tool_calls',
      assistantContent: '下一个关键问题：任务数据要怎么保存？\n\n你选哪一种？'
    })

    expect(transition).toBe(TransitionEvent.ToolExecuted)
  })

  it('pauses when the repeated tool failure guard is reached', () => {
    const transition = resolveAgentTransition({
      toolCallCount: 1,
      isVerificationFailure: false,
      verificationRetryCount: 0,
      maxVerificationRetries: 3,
      repeatedFailureLimitReached: true
    })

    expect(transition).toBe(TransitionEvent.RepeatedFailure)
  })

  it('requests another pass after verification fails', () => {
    const transition = resolveAgentTransition({
      toolCallCount: 0,
      isVerificationFailure: true,
      verificationRetryCount: 1,
      maxVerificationRetries: 3
    })

    expect(transition).toBe(TransitionEvent.RetryRequested)
  })
})
