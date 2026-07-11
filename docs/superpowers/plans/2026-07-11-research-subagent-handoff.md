# Research Subagent Handoff Implementation Plan

> **For agentic workers:** Execute inline in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Research subagents return a general Markdown handoff with evidence anchors, reserve turns for structured completion, and fail visibly when no valid result is submitted.

**Architecture:** The Research definition owns the generic Markdown contract. `SubAgentManager` splits the bounded run into an exploration phase and a finalization phase where only `submit_result` is available. Valid reports become the result payload used by both the parent tool result and the UI; invalid or exhausted runs propagate a failed status.

**Tech Stack:** TypeScript, Electron main process, React, Vitest.

## Global Constraints

- Do not include source code excerpts in Research handoffs.
- Every material finding must cite `file_path:start_line-end_line`.
- Preserve plain-text completion for subagents without an output specification.
- Do not modify existing user changes in chat rendering files.

---

### Task 1: Define the Research handoff contract

**Files:**
- Modify: `src/main/agent/definitions/ResearchSubAgent.ts`
- Test: `src/tests/research-subagent-prompt.test.ts`

**Produces:** A generic `report` prompt contract with direct answer, findings, relevant components, priority references, risks, and open questions; default exploration budget values that leave room for finalization.

- [x] Write a prompt test asserting generic headings and evidence-anchor rules.
- [x] Update the Research definition and its system prompt without technology-specific wording.
- [x] Run `npm test -- src/tests/research-subagent-prompt.test.ts`.

### Task 2: Reserve completion turns and reject unstructured exhaustion

**Files:**
- Modify: `src/main/agent/SubAgentManager.ts`
- Modify: `src/main/agent/AgentRunner/subAgentRunnerHelper.ts`
- Test: `src/tests/subagent-manager-protocol.test.ts`
- Test: `src/tests/subagent-runner-helper.test.ts`

**Produces:** Structured subagents switch to a submit-only finalization phase, return `report` as output after a valid submission, and report failure after budget exhaustion without a valid result.

- [x] Add tests for finalization-only tools, successful report forwarding, failed unstructured completion, and failed-result propagation.
- [x] Implement phase-specific tool selection, a finalization continuation, and explicit `SubAgentResult` status.
- [x] Propagate the returned status through the runner helper and preserve the existing success payload shape for completed results.
- [x] Run `npm test -- src/tests/subagent-manager-protocol.test.ts`.

### Task 3: Verify integration

**Files:**
- Test: `src/tests/subagent-manager-protocol.test.ts`

**Produces:** Regression coverage for the reported failure mode and clean type checking.

- [x] Run the focused Research prompt and protocol tests.
- [x] Run `npm run typecheck`.
- [x] Run `npm test -- src/tests/subagent-output-helper.test.ts src/tests/subagent-manager-recovery.test.ts`.
