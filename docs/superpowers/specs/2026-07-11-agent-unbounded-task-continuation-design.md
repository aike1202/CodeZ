# Agent Unbounded Task Continuation Design

## Goal

Prevent the main Agent from stopping only because it reached a fixed loop count. The Agent must continue until the task is complete or execution reaches an explicit blocking condition.

## Current Behavior

`AgentRunner` limits each run to 30 loops. Near the limit, it replaces every requested tool execution with an error instructing the model to summarize progress and ask the user to click “Continue”. On the following text-only response, `resolveAgentTransition` returns `Completed` even when `TaskStore` still contains `pending` or `in_progress` tasks.

This produces a false successful completion: work remains, but the stream ends and the user must manually restart it.

## Desired Behavior

- Do not impose a total Agent loop limit.
- Continue consuming tool results and executing subsequent tool calls for as long as the task is making progress.
- Treat `pending` or `in_progress` tasks as authoritative evidence that the run is incomplete.
- When the model emits a text-only progress update while tasks remain, record an internal continuation instruction and start another model loop.
- Finish normally only when no task remains active and the model emits a terminal text response without tool calls.
- Stop or pause on explicit blocking conditions: user cancellation, Provider failure, permission or user-input requests, repeated tool failure, or repeated idle turns with no progress.

## Architecture

The change stays inside the existing `AgentRunner` state machine. It does not create new IPC streams, new transactions, or scheduler-owned continuation turns. Keeping one runner preserves the canonical context ledger, edit transaction, streamed UI message, accumulated tool results, and compaction behavior.

### Loop Lifetime

Replace the `loopCount < MAX_LOOPS` condition with a loop controlled by cancellation and terminal state transitions. Retain `loopCount` for diagnostics, logging, tests, and progress visibility.

Remove the branch that suspends tool calls near the 30-loop boundary and generates the manual-continue message.

### Completion Resolution

Extend `resolveAgentTransition` so its inputs affect the transition in this order:

1. Tool calls executed: return `ToolExecuted`.
2. Failed verification with retries remaining: return `RetryRequested`.
3. Active tasks remain: return `SchedulerContinue` unless the idle threshold has been reached.
4. Idle threshold reached: return `MaxIdleReached`.
5. No active tasks and no tool calls: return `Completed`.

The runner must pass `hasPendingTasks` into this function. Provider stop reasons such as `stop` or `length` must not override active task state.

### Progress and Idle Detection

An idle turn is a model turn that:

- executes no tool call;
- leaves at least one task `pending` or `in_progress`; and
- does not change the active task status snapshot.

For the first two consecutive idle turns, record a continuation instruction explaining that active tasks remain and that the model must either continue with tools, update task status, or explicitly request required user input through the supported interaction tool.

On the third consecutive idle turn, transition to `WaitingUser`. This is an explicit no-progress block rather than a loop-budget stop. Any successful tool execution or task-status change resets the idle counter.

### Safety Exits

The existing safety paths remain in force:

- user abort closes the runtime turn as interrupted;
- unrecoverable Provider errors stop the run;
- context overflow attempts compaction before failing;
- consecutive failed tool batches retain their existing safety behavior, but the response must identify the repeated failure rather than a loop limit;
- permission and `AskUserQuestion` requests continue using their existing UI flows;
- verification failures retain the bounded retry policy.

There is deliberately no fallback total-loop limit. A run that continues making observable progress may run indefinitely, as requested.

## Files

- Modify `src/main/agent/AgentRunner/index.ts` to remove the fixed loop cap, route active task state into transition resolution, track idle progress, and inject internal continuation instructions.
- Modify `src/tests/agent-runner-transition.test.ts` to replace the current tests that explicitly permit completion with active tasks.
- Add or extend an AgentRunner integration-style test to prove tool execution remains enabled after loop 30 and that three unchanged idle turns pause the run.

No renderer or IPC change is required because the same stream and transaction remain active.

## Testing

Automated verification must cover:

- active tasks plus a text-only `stop` response returns `SchedulerContinue`;
- active tasks plus a `length` response also returns `SchedulerContinue`;
- no active tasks plus a text-only response returns `Completed`;
- tool execution still returns `ToolExecuted` after a diagnostic loop count greater than 30;
- successful progress resets consecutive idle turns;
- three unchanged idle turns return `MaxIdleReached`;
- verification retry behavior remains unchanged;
- existing AgentRunner and context-ledger tests pass;
- `npm run typecheck` and `npm run build` pass.

## Non-Goals

- No new background scheduler or separate continuation stream.
- No user-configurable loop limit.
- No semantic classifier that guesses whether free-form prose means “complete”.
- No changes to SubAgent loop budgets; this design applies to the main Agent only.
- No unrelated refactoring of the context, permission, or renderer systems.

