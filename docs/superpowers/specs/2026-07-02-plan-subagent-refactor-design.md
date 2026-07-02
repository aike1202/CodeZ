---
name: plan-mode-refactor
description: "Specification for refactoring CodeZ Plan Mode from config-driven to SubAgent-driven architecture."
metadata:
  type: project
---

# Plan Mode Refactor Specification

**Goal:** Refactor the existing Plan Mode from a configuration-flag-driven approach to an Agent-driven SubAgent architecture, aligning closer to Claude Code's model but adapted for CodeZ's specific UI and architectural constraints.

**Architecture:** Introduce a generic `SubAgentManager` to handle lifecycle and isolation of subagents. Create a specific `PlanSubAgent` definition. Replace `SubmitPlanTool` with `EnterPlanModeTool` (main agent) and `ExitPlanModeTool` (subagent). Update the React frontend to display a new inline `PlanApprovalCard` and a `PlanCapsule` in the TopBar for execution tracking.

**Tech Stack:** TypeScript, Electron (IPC), React, Zustand.

## Global Constraints

- Do not modify `Provider` layer logic.
- Plan storage remains Markdown + YAML frontmatter via `PlanStore`.
- Strict isolation of SubAgent context (independent message history and loop count).
- Frontend UI must not block the main chat flow; use inline cards.

---

## 1. SubAgent Framework (Backend)

The core abstraction for running isolated agent tasks.

### `src/main/agent/SubAgentManager.ts`

- **Purpose:** Manages registration, lifecycle, and execution of SubAgents.
- **Interfaces:**
  - `SubAgentDefinition`: Defines type, description, `systemPromptBuilder`, `getTools()`, `maxLoops`, and optional lifecycle hooks (`onBeforeSpawn`, `onAfterComplete`).
  - `SubAgentContext`: Contains `workspaceRoot`, `sessionId`, `parentPrompt` (the task description), and `apiConfig`.
  - `SubAgentResult`: Contains final `output`, `toolCallCount`.
- **Execution (`spawn` method):**
  - Creates a new AbortController.
  - Instantiates a fresh `ChatService` loop.
  - Initializes message history with only the `systemPrompt` and the `parentPrompt`.
  - Uses `StreamCallbacks` passed from the main `AgentRunner` to stream tool calls and thoughts in real-time to the frontend.
  - Returns `SubAgentResult` upon completion or error.

### `src/main/agent/definitions/PlanSubAgent.ts`

- **Purpose:** The specific definition for the Plan SubAgent.
- **Properties:**
  - `type`: `'Plan'`
  - `maxLoops`: `15`
  - `getTools()`: Returns read-only tools + `Write` + `ExitPlanMode`.
  - `systemPromptBuilder()`: Instructions to explore the codebase, design a plan, write it to `.codez/plans/` using the `Write` tool, and call `ExitPlanMode` to trigger approval.

---

## 2. Tooling (Backend)

Replacing the single `SubmitPlanTool` with a two-tool boundary.

### `src/main/tools/builtin/EnterPlanModeTool.ts`

- **Purpose:** Used by the *Main Agent* to suggest entering Plan Mode based on task complexity.
- **Execution:**
  - Intercepted by `AgentRunner` (does not execute standard tool logic).
  - Triggers a user confirmation request via IPC (`onAskUserRequest` / `CHAT_REQUEST_ASK_USER`).
  - If user accepts: `AgentRunner` calls `SubAgentManager.spawn('Plan', ...)`.
  - Returns the result of the SubAgent to the Main Agent.
- **Parameters:** `{}` (empty schema).

### `src/main/tools/builtin/ExitPlanModeTool.ts`

- **Purpose:** Used by the *Plan SubAgent* to signal plan completion and trigger user review.
- **Execution:**
  - Reads the most recently written markdown plan from `.codez/plans/` via `PlanStore`.
  - Calls `PlanService.submitForReview()` to set status to `pending_review`.
  - Triggers IPC `plan:review-request`.
  - Suspends the SubAgent loop waiting for a decision.
  - If Approved: SubAgent terminates, returns success.
  - If Rejected (Request Changes): SubAgent resumes with feedback provided as the tool result, continuing its loop to refine the plan.
- **Parameters:**
  - `allowedPrompts` (optional array of required bash/powershell permissions for future execution).

---

## 3. AgentRunner Refactor (Backend)

Modifying the main execution loop to handle the new tool interceptions.

### `src/main/agent/AgentRunner.ts`

- **Deletions:**
  - Remove all `if (config.planMode)` branches that altered tool sets and system prompts based on a boolean flag.
  - Remove the old `SubmitPlanTool` interception logic.
- **Additions:**
  - Add interception for `EnterPlanMode`. When called, trigger the user confirmation UI. If approved, await `SubAgentManager.spawn()`.
  - The `activePlan` injection logic (adding `<active_plan>` to `allMessages`) is retained and runs universally if an executing plan exists in the workspace.

---

## 4. IPC Channels

Connecting the new backend flows to the frontend React application.

### `src/shared/ipc/channels.ts`

- **Additions:**
  - `PLAN_ENTER_REQUEST`: 'plan:enter-request' (main -> renderer)
  - `PLAN_ENTER_RESPONSE`: 'plan:enter-response' (renderer -> main)
  - `PLAN_SUBAGENT_PROGRESS`: 'plan:subagent-progress' (main -> renderer, for real-time UI updates during exploration)

---

## 5. Frontend UI/UX (React & Zustand)

Designing the new visual components and state management.

### `src/renderer/src/stores/chatStore.ts`

- **Modifications:**
  - Remove `planMode` boolean state and `togglePlanMode` action.
  - Add state for tracking SubAgent progress (`subAgentStatus: 'running' | 'idle'`).

### `src/renderer/src/components/chat/PlanApprovalCard.tsx` (New)

- **Purpose:** Replaces the old modal `PlanPanel`. An inline card rendered within the chat message stream when `ExitPlanMode` is called.
- **Features:**
  - Displays Plan Title and Description.
  - Lists Plan Steps (id, title, files involved).
  - Actions: `✅ Approve` and `🔄 Request Changes` (opens a feedback input field).

### `src/renderer/src/components/PlanCapsule.tsx` (New)

- **Purpose:** A persistent indicator in the top right (`TopBar`) when a plan is `executing`.
- **Features:**
  - **Collapsed State:** Small pill shape showing `▶ plan-slug (Step 2/5)`.
  - **Expanded State (Popover):** Shows full step list with status icons (⬜ pending, 🔄 in_progress, ✅ completed). Click outside to close.

### Integration

- Update `ChatAreaLayout.tsx` to remove the old `PlanPanel`.
- Update `TopBar.tsx` to include `<PlanCapsule />`.
- Ensure `AskUserQuestionWidget` (or similar) handles the `EnterPlanMode` confirmation prompt gracefully.
