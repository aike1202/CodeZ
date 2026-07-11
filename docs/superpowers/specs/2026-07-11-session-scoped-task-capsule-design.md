# Session-Scoped Task Capsule Lifecycle Design

## Goal

Keep Task UI state strictly scoped to its chat session and move terminal Task
states out of the capsule into the existing persisted `TaskUpdate` execution
log.

The expected lifecycle is:

- `pending` and `in_progress` Tasks appear in the active session's capsule.
- `completed` Tasks immediately leave the capsule and retain a clickable
  `完成任务：<subject>` execution-log entry.
- `cancelled` Tasks immediately leave the capsule and retain a clickable
  `取消任务：<subject>` execution-log entry.
- Creating or selecting a session never displays Tasks from another session.

## Existing Behavior and Root Cause

Task persistence is already session-scoped. `TaskStore` buckets Tasks by
`sessionId`, writes each list to `SessionData.tasks`, and includes `sessionId`
in `TASK_UPDATED` broadcasts. The renderer subscription also ignores updates
for inactive sessions.

The visible leak occurs because `createSession` resets `messages` but leaves
the renderer's current `tasks` array unchanged. Session selection restores the
correct Task array, but its capsule expansion state can also be inherited from
the previously active session.

The capsule currently renders all persisted Tasks, including terminal Tasks.
This leaves a `Tasks 4/4` capsule visible after work finishes even though the
associated `TaskUpdate` tool call is already represented in the execution
timeline.

## Design

### Session State Isolation

Creating a session initializes all session-derived Task presentation state:

- Set the active `tasks` array to an empty list.
- Close the Task capsule by clearing `expandedCapsule` when it is `task`.
- Preserve no Task presentation state from the previous session.

Selecting a session continues to load `session.tasks`, but derives capsule
visibility and expansion from that selected session only. A session without
active Tasks must not inherit an expanded Task capsule from the previous
session.

The persisted `SessionData.tasks` list remains unchanged and continues to
contain terminal Tasks. It is the authoritative Task state used by tools and
session recovery.

### Capsule Projection

The capsule is a projection of active work, not Task history. Before computing
counts, labels, ordering, or rendering rows, it filters Tasks to these states:

- `pending`
- `in_progress`

When the filtered list is empty, the capsule returns `null`. Consequently, a
Task disappears as soon as its status becomes `completed` or `cancelled`, and
the capsule disappears when no active Tasks remain.

Terminal Tasks are not deleted from the store or session. This preserves Task
IDs, tool context, summaries, and recovery behavior.

### Reused TaskUpdate Log

No new message or event type is introduced. The existing `TaskUpdate` tool
timeline entry remains the single completion/cancellation log source.

`TaskUpdate` returns a complete snapshot of the updated `TaskItem` rather than
the current reduced `{ id, subject, status }` object. The snapshot is captured
in the tool result already stored in the agent message's `executionTimeline`,
so it follows the existing session persistence path and cannot leak between
sessions.

Timeline summary text remains:

- `完成任务：<subject>` for `completed`
- `取消任务：<subject>` for `cancelled`

The log row stays clickable. Its expanded detail presents structured fields
from the terminal snapshot when available:

- Final status
- Description
- Involved files
- Acceptance criteria
- Verification command

Older persisted `TaskUpdate` results may contain only the reduced snapshot.
They continue to render their summary and fall back to the existing raw tool
detail without migration.

## Data Flow

1. The Agent calls `TaskUpdate` with `completed` or `cancelled`.
2. `TaskStore.update(sessionId, taskId, patch)` updates and persists the full
   session Task list.
3. `TaskStore` broadcasts the session-scoped Task list.
4. The active renderer session accepts the matching broadcast.
5. The capsule filters out the terminal Task immediately.
6. `TaskUpdate` returns the full updated Task snapshot.
7. The existing tool timeline records that result in the current agent
   message and persists it with the session.
8. The execution log renders the terminal summary and structured detail.

## Error and Compatibility Handling

- A failed `TaskUpdate` does not produce a successful completion or
  cancellation summary and does not remove the Task from the capsule.
- Updates broadcast for inactive sessions remain ignored by the active view;
  their persisted session data is loaded when that session is selected.
- Legacy sessions with no `tasks` field resolve to an empty Task list.
- Legacy tool results remain readable without a data migration.
- `cancelled` and `completed` remain persisted terminal states; filtering is
  presentation-only.

## Testing

Add focused regression coverage for:

1. Creating a new session clears visible Tasks and Task capsule expansion.
2. Selecting a session restores only that session's Task list.
3. Selecting a session with no active Tasks does not inherit Task capsule
   expansion.
4. The capsule displays only `pending` and `in_progress` Tasks.
5. `completed` and `cancelled` Tasks immediately disappear from the capsule.
6. `TaskUpdate` returns the complete updated Task snapshot.
7. Completed and cancelled timeline entries retain their expected summary and
   expose structured terminal Task detail.
8. Legacy reduced `TaskUpdate` results still render without errors.

Run the targeted Task/session and execution-log tests, then run TypeScript
type-checking and the full test suite if the targeted checks pass.

## Out of Scope

- A new Task event/history database
- Synthetic system messages for Task transitions
- Deleting terminal Tasks from `SessionData.tasks`
- Changing Task status transition rules
- Redesigning the capsule or general execution-log appearance
