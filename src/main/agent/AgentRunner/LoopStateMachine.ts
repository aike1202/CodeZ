export enum AgentState {
  Running = 'Running',
  WaitingUser = 'WaitingUser',
  Suspended = 'Suspended',
  Terminated = 'Terminated'
}

export enum TransitionEvent {
  ToolExecuted = 'ToolExecuted',
  RetryRequested = 'RetryRequested',
  OutputTruncated = 'OutputTruncated',
  SchedulerContinue = 'SchedulerContinue',
  MaxIdleReached = 'MaxIdleReached',
  WaitingInput = 'WaitingInput',
  Completed = 'Completed',
  Failed = 'Failed',
  Cancelled = 'Cancelled'
}

export enum TerminationReason {
  Completed = 'Completed',
  Failed = 'Failed',
  Cancelled = 'Cancelled',
  MaxLoop = 'MaxLoop',
  FatalError = 'FatalError'
}

type TransitionTable = Record<AgentState, Partial<Record<TransitionEvent, AgentState>>>;

const FSM_TABLE: TransitionTable = {
  [AgentState.Running]: {
    [TransitionEvent.ToolExecuted]: AgentState.Running,
    [TransitionEvent.RetryRequested]: AgentState.Running,
    [TransitionEvent.OutputTruncated]: AgentState.Running,
    [TransitionEvent.SchedulerContinue]: AgentState.Running,
    [TransitionEvent.MaxIdleReached]: AgentState.WaitingUser,
    [TransitionEvent.WaitingInput]: AgentState.WaitingUser,
    [TransitionEvent.Completed]: AgentState.Terminated,
    [TransitionEvent.Failed]: AgentState.Terminated,
  },
  [AgentState.WaitingUser]: {
    [TransitionEvent.SchedulerContinue]: AgentState.Running,
    [TransitionEvent.Cancelled]: AgentState.Terminated,
  },
  [AgentState.Suspended]: {
    [TransitionEvent.SchedulerContinue]: AgentState.Running,
    [TransitionEvent.Cancelled]: AgentState.Terminated,
  },
  [AgentState.Terminated]: {}
};

export class LoopStateMachine {
  /**
   * Pure Finite State Machine transition lookup.
   */
  static next(currentState: AgentState, event: TransitionEvent): AgentState {
    const nextState = FSM_TABLE[currentState]?.[event];
    if (!nextState) {
      throw new Error(`Invalid FSM transition: from state [${currentState}] with event [${event}]`);
    }
    return nextState;
  }
}
