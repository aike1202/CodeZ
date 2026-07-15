# Model-Directed Tool Approval Implementation Plan

> **Implementation note:** Execute tasks in order. Each task starts with focused failing tests, makes the smallest production change that passes them, and ends with the listed verification command.

**Goal:** Add one model-selected approval preference to every effectful tool while retaining runtime-enforced absolute redlines and the existing auto-mode permission boundary.

**Architecture:** The canonical tool registry decorates effectful schemas with required `approval: 'auto' | 'user'` metadata. Both runtime pipelines validate and extract it before planning or execution. `PermissionManager` combines the model preference with explicit rules, the active workspace mode, and a narrowed absolute-redline guard. Main agents, subagents, MCP tools, the approval UI, and audit logs share the same contracts.

**Tech Stack:** TypeScript, Electron, React, Vitest, AJV, web-tree-sitter

**Design:** `docs/superpowers/specs/2026-07-15-model-directed-tool-approval-design.md`

## Global Constraints

- Preserve unrelated worktree changes and do not commit implementation work unless the user asks.
- Keep `auto | full-access` persistence backward compatible.
- Do not pass the CodeZ-owned `approval` field into built-in, MCP, or plugin handlers.
- Do not allow hooks, stored allow rules, MCP annotations, or model output to bypass an absolute redline.
- Keep auto mode at least as restrictive as it is now.
- Treat missing/invalid approval metadata as a recoverable input error, not an approval request.
- Update both `ToolExecutionPipeline` and `LegacyToolExecutionPipeline`; feature flags must not change the contract.
- Use explicit UTF-8 PowerShell setup for commands that read or print repository text.

---

### Task 1: Add Approval Contracts and Canonical Schema Decoration

**Files:**

- Modify: `src/shared/types/permission.ts`
- Modify: `src/shared/types/index.ts`
- Modify: `src/main/tools/runtime/types.ts`
- Create: `src/main/tools/runtime/ToolApprovalPolicy.ts`
- Modify: `src/main/tools/runtime/ToolRegistry.ts`
- Modify: `src/main/tools/runtime/LegacyToolAdapter.ts`
- Modify: `src/main/tools/mcp/McpToolHandler.ts`
- Create: `src/tests/tool-approval-policy.test.ts`
- Modify: `src/tests/tool-runtime-properties.test.ts`
- Modify: `src/tests/mcp-tool-handler.test.ts`
- Modify: `src/tests/tool-schema-baseline.test.ts`

**Interfaces:**

```ts
export type ToolApprovalPreference = 'auto' | 'user'

export interface ToolApprovalMetadata {
  modelPreference: 'not-applicable' | 'required'
}

export interface ToolDescriptor {
  // existing fields
  approval: ToolApprovalMetadata
}
```

- [ ] Add failing tests for schema decoration, required-field insertion, original-schema immutability, duplicate required entries, and collision rejection when a tool already owns `approval`.
- [ ] Add `approval` metadata as a mandatory `ToolDescriptor` field so new tool adapters cannot silently omit the policy.
- [ ] Mark provably read-only built-ins `not-applicable`; mark writes, shell, web, rollback, notifications, task/session mutation, delegation, execution control, and unknown tools `required`.
- [ ] Mark MCP tools `not-applicable` only when `readOnlyHint === true` and `destructiveHint !== true`; otherwise use `required`.
- [ ] Implement `decorateApprovalSchema(schema, metadata)` as a pure helper that clones the object schema, appends the required enum property, and throws an actionable registration error on collision or non-object schemas.
- [ ] Decorate handlers centrally in `ToolRegistry.register`, retaining bound execution methods and `legacyTool` compatibility.
- [ ] Ensure decorated schemas participate in descriptor versions, catalog fingerprints, exposure fingerprints, and provider definitions.
- [ ] Update schema baselines without weakening existing required fields.
- [ ] Run:

```powershell
npm.cmd test -- --run src/tests/tool-approval-policy.test.ts src/tests/tool-runtime-properties.test.ts src/tests/mcp-tool-handler.test.ts src/tests/tool-schema-baseline.test.ts
```

Expected: PASS.

### Task 2: Extract Runtime Metadata in Both Tool Pipelines

**Files:**

- Modify: `src/main/tools/runtime/types.ts`
- Modify: `src/main/tools/runtime/ToolApprovalPolicy.ts`
- Modify: `src/main/tools/runtime/ToolExecutionPipeline.ts`
- Modify: `src/main/tools/runtime/LegacyToolExecutionPipeline.ts`
- Modify: `src/main/tools/runtime/ToolHookRunner.ts`
- Modify: `src/tests/tool-execution-pipeline.test.ts`
- Modify: `src/tests/legacy-tool-execution-pipeline.test.ts`
- Modify: `src/tests/tool-runtime-v1-v2-baseline.test.ts`
- Modify: `src/tests/mcp-tool-handler.test.ts`

**Interfaces:**

```ts
export interface PreparedToolCall {
  // existing fields
  approvalPreference: ToolApprovalPreference | null
}

export function extractToolApproval(
  input: Record<string, unknown>,
  metadata: ToolApprovalMetadata
): { approvalPreference: ToolApprovalPreference | null; businessInput: Record<string, unknown> }
```

- [ ] Add failing V2 tests proving missing/invalid values return recoverable `TOOL_INPUT_INVALID` before authorization.
- [ ] Add failing tests proving planners, resource-key functions, authorization, hooks, built-in handlers, and MCP `callTool` receive business input without `approval`.
- [ ] Validate the model-facing input first, then extract the preference and strip the control field before effect/resource planning.
- [ ] Preserve `approvalPreference` separately on `PreparedToolCall` through scheduling and execution.
- [ ] When a before-hook replaces business input, revalidate by temporarily reattaching the original preference, then strip again; hooks cannot replace the preference.
- [ ] Upgrade the legacy pipeline to compile/validate the same canonical schema and perform the same extraction instead of permissively parsing malformed arguments.
- [ ] Add V1/V2 parity assertions for valid, missing, invalid, read-only, and effectful calls.
- [ ] Update affected test fixtures to provide `approval: 'auto'` only for effectful tool calls; do not introduce a hidden runtime default.
- [ ] Run:

```powershell
npm.cmd test -- --run src/tests/tool-execution-pipeline.test.ts src/tests/legacy-tool-execution-pipeline.test.ts src/tests/tool-runtime-v1-v2-baseline.test.ts src/tests/mcp-tool-handler.test.ts
```

Expected: PASS.

### Task 3: Implement the Model-Preference Decision Matrix

**Files:**

- Modify: `src/shared/types/permission.ts`
- Modify: `src/main/services/permission/PermissionDecisionEngine.ts`
- Modify: `src/main/services/PermissionManager.ts`
- Modify: `src/tests/permission-contracts.test.ts`
- Modify: `src/tests/permission-decision-engine.test.ts`
- Modify: `src/tests/permission-manager.test.ts`
- Modify: `src/tests/tool-effect-permission.test.ts`

**Interfaces:**

```ts
export type PermissionApprovalSource =
  | 'model-requested'
  | 'runtime-policy'
  | 'absolute-redline'

export interface PermissionDecision {
  // existing fields
  modelApprovalPreference: ToolApprovalPreference | null
  approvalSource?: PermissionApprovalSource
  absoluteRedline: boolean
}
```

- [ ] Add a table-driven failing test for explicit deny, absolute redline, model `user`, model `auto`, both permission modes, and read-only calls with no preference.
- [ ] Extend the authorization entry point to receive the extracted preference explicitly rather than reading a business argument.
- [ ] Make model `user` force `ask` in both modes unless an explicit rule already denies the call.
- [ ] Make model `auto` use current capability rules in auto mode and allow normal capabilities in full-access mode.
- [ ] Preserve explicit deny precedence and input snapshot revalidation.
- [ ] Populate `approvalSource`: `model-requested` for model `user`, `runtime-policy` for an auto-mode rule ask, and `absolute-redline` for forced redlines.
- [ ] Keep absolute-redline requests once-only; normal model/policy requests retain their existing allowed scopes.
- [ ] Ensure read-only tools without the parameter retain their current decisions.
- [ ] Run:

```powershell
npm.cmd test -- --run src/tests/permission-contracts.test.ts src/tests/permission-decision-engine.test.ts src/tests/permission-manager.test.ts src/tests/tool-effect-permission.test.ts
```

Expected: PASS.

### Task 4: Split Absolute Redlines From Model-Directed High Risk

**Files:**

- Modify: `src/main/services/permission/CriticalOperationGuard.ts`
- Modify: `src/main/services/permission/commandPolicies.ts`
- Modify: `src/main/services/PermissionManager.ts`
- Modify: `src/tests/permission-critical-guard.test.ts`
- Modify: `src/tests/permission-manager.test.ts`
- Modify: `src/tests/permission-operation-analysis.test.ts`
- Modify: `src/tests/permission-command-corpus.test.ts`

**Interfaces:**

```ts
export type CriticalEnforcement = 'absolute-redline' | 'model-directed'

export interface CriticalOperationFinding {
  ruleId: string
  reason: string
  impact: PermissionImpact
  enforcement: CriticalEnforcement
  permission: PermissionCapability
}
```

- [ ] Convert `CriticalOperationGuard` from an unconditional ask-decision producer into a finding producer; `PermissionManager` owns final action selection.
- [ ] Add failing tests for every absolute category: disk format/partition/raw write, root/system/home/workspace deletion, shutdown/reboot/fork bomb, elevation, account/group/security/firewall mutation, service creation/deletion/configuration, startup persistence, credentials/tokens, and CodeZ permission-store mutation.
- [ ] Keep those findings `absolute-redline`, risk level 4, once-only, and impossible to downgrade with model `auto` or stored allow rules.
- [ ] Reclassify force push as model-directed `external_effect`.
- [ ] Reclassify fetch-and-execute as model-directed `network`.
- [ ] Reclassify encoded/dynamic/hidden execution as model-directed `shell_unparsed`.
- [ ] Split service operations: start/stop/restart of an existing service are model-directed `external_effect`; create/delete/config/enable/disable/mask/unmask/edit/persistence changes remain absolute.
- [ ] Verify model-directed findings ask in auto mode, allow in full-access with model `auto`, and ask in either mode with model `user`.
- [ ] Retain shell parsing, nested expansion, snapshot hashing, and compound-operation aggregation.
- [ ] Run:

```powershell
npm.cmd test -- --run src/tests/permission-critical-guard.test.ts src/tests/permission-manager.test.ts src/tests/permission-operation-analysis.test.ts src/tests/permission-command-corpus.test.ts
```

Expected: PASS.

### Task 5: Wire Main Agents, Subagents, and Prompt Guidance

**Files:**

- Modify: `src/main/agent/AgentRunner/index.ts`
- Modify: `src/main/agent/SubAgentManager.ts`
- Modify: `src/main/services/prompts/execution/ToolPolicy.ts`
- Modify: `src/main/services/prompts/PromptTypes.ts` if contract propagation requires it
- Modify: `src/tests/agent-runner-tool-result.test.ts`
- Modify: `src/tests/subagent-permission-scope.test.ts`
- Modify: `src/tests/subagent-shared-tool-policy.test.ts`
- Modify: `src/tests/system-prompt-service.test.ts`

**Interfaces:**

- Main and subagent authorization callbacks consume `prepared.approvalPreference`.
- Existing subagent capability scope, executor lease, and shell policy checks continue to run before general permission authorization.

- [ ] Add failing tests proving main and subagent calls pass the same preference into `authorizePermissionToolCall`.
- [ ] Ensure subagent scope/lease denials cannot be overridden by model `auto`.
- [ ] Ensure subagent absolute-redline approvals retain `agentId` and route through the parent approval handler.
- [ ] Update tool policy guidance: choose `auto` for routine understood work; choose `user` for irreversible, externally publishing, user-data-affecting, or ambiguous actions; do not select `user` indiscriminately.
- [ ] Remove or revise prompt text that says all high-risk commands are automatically user-approved by runtime when it conflicts with the new model choice.
- [ ] Update mocked provider tool calls and fixtures to include the parameter for effectful calls.
- [ ] Run:

```powershell
npm.cmd test -- --run src/tests/agent-runner-tool-result.test.ts src/tests/subagent-permission-scope.test.ts src/tests/subagent-shared-tool-policy.test.ts src/tests/system-prompt-service.test.ts
```

Expected: PASS.

### Task 6: Explain Approval Sources in UI and Audit Logs

**Files:**

- Modify: `src/shared/types/permission.ts`
- Modify: `src/main/services/permission/PermissionAuditLog.ts` if event typing/helpers are introduced
- Modify: `src/main/services/PermissionManager.ts`
- Modify: `src/renderer/src/components/PromptArea/components/PermissionModeSelector.tsx`
- Modify: `src/renderer/src/components/chat/PermissionApprovalWidget.tsx`
- Modify: `src/renderer/src/components/chat/PermissionApprovalWidget.css`
- Modify: `src/renderer/src/components/chat/permissionApprovalOptions.ts`
- Modify: `src/tests/permission-audit-log.test.ts`
- Modify: `src/tests/permission-approval-options.test.ts`
- Modify: `src/tests/permission-approval-viewport.test.ts`

**Interfaces:**

- Approval cards render one of: `模型请求确认`, `权限策略要求确认`, or `绝对红线：必须确认`.
- Audit events include requested preference, effective action, approval source, decisive rule ID, mode, session, and agent ID.

- [ ] Add failing audit tests for the three sources and existing credential/token redaction.
- [ ] Record the model preference even when an explicit deny or redline overrides it.
- [ ] Add source-specific labels and restrained visual emphasis; reserve the critical style for absolute redlines.
- [ ] Update the full-access selector description so it explains that model-requested confirmations may appear and absolute redlines always require confirmation; remove the inaccurate claim that only current "extremely dangerous" operations can prompt.
- [ ] Keep absolute-redline approval options once-only; model and policy approvals use the decision's existing scope list.
- [ ] Keep long commands and reasons within the existing viewport constraints.
- [ ] Run:

```powershell
npm.cmd test -- --run src/tests/permission-audit-log.test.ts src/tests/permission-approval-options.test.ts src/tests/permission-approval-viewport.test.ts
```

Expected: PASS.

### Task 7: Resolve Pending Approvals on Stream Teardown

**Files:**

- Modify: `src/main/ipc/chat.handlers.ts`
- Modify: `src/preload/index.ts` only if explicit renderer cleanup notification is required
- Modify: `src/tests/chat-runtime-ipc.test.ts`
- Modify: `src/tests/chat-stream-v2.test.ts`

**Interfaces:**

- Pending approvals are tracked by `streamId` and have one idempotent denial/cleanup closure.
- `finishStream`, explicit stop, sender destruction, timeout, and a valid response all settle and unregister the request exactly once.

- [ ] Add failing tests for explicit stream stop while approval is pending, sender destruction, timeout, duplicate response, and normal approval.
- [ ] Register each pending approval in a stream-scoped set before sending the IPC request.
- [ ] Make `finishStream(streamId)` deny and clean all pending approvals for that stream before unregistering the runner.
- [ ] Retain sender-destroyed and bounded-timeout fallbacks.
- [ ] If preload stream cleanup can occur without main-process stream stop, send an explicit cancellation; otherwise document and test that `CHAT_STREAM_STOP` is sufficient.
- [ ] Verify a closed renderer or stopped run cannot remain blocked on an invisible approval promise.
- [ ] Run:

```powershell
npm.cmd test -- --run src/tests/chat-runtime-ipc.test.ts src/tests/chat-stream-v2.test.ts
```

Expected: PASS.

### Task 8: Full Regression and Manual Acceptance

**Files:**

- Modify: affected provider/tool-call test fixtures discovered by the full suite
- Verify: all implementation files above

- [ ] Run all permission tests using an explicit file list if PowerShell does not expand the glob.
- [ ] Run the tool runtime, MCP, subagent, provider-payload, and chat IPC suites.
- [ ] Run the full Vitest suite.
- [ ] Run TypeScript checking and the Electron build.
- [ ] Run whitespace/error checks and inspect the final diff for unrelated changes.

```powershell
npm.cmd test -- --run src/tests/permission-contracts.test.ts src/tests/permission-decision-engine.test.ts src/tests/permission-manager.test.ts src/tests/permission-critical-guard.test.ts src/tests/permission-operation-analysis.test.ts src/tests/permission-command-corpus.test.ts src/tests/permission-audit-log.test.ts src/tests/permission-approval-options.test.ts
npm.cmd test -- --run src/tests/tool-approval-policy.test.ts src/tests/tool-execution-pipeline.test.ts src/tests/legacy-tool-execution-pipeline.test.ts src/tests/tool-runtime-v1-v2-baseline.test.ts src/tests/mcp-tool-handler.test.ts src/tests/subagent-permission-scope.test.ts src/tests/chat-runtime-ipc.test.ts
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
git diff --check
```

- [ ] Start CodeZ in development mode and verify a full-access workspace:
  - Routine Edit/Write/build/test with `approval: auto` runs without an approval card.
  - Network and force-push mock/dry-run calls with `approval: auto` do not require approval in full-access mode.
  - The same model-directed high-risk calls still ask in auto mode.
  - `approval: user` produces a model-requested card in both modes.
  - Representative absolute-redline commands are intercepted before execution and show a once-only critical card.
  - Stopping the stream while a card is pending resolves the request as denied.
- [ ] Confirm no tool or MCP server receives the `approval` field in its business arguments.
- [ ] Confirm permission audit entries explain requested preference, effective source, override rule, mode, and agent identity without leaking test secrets.

## Completion Criteria

- Every effectful tool source has the same explicit model preference contract.
- Both runtime pipelines reject missing metadata consistently and strip it before execution.
- Full-access plus model `auto` runs unattended except for explicit denies and absolute redlines.
- Auto mode cannot be weakened by model `auto`.
- Main agents and subagents behave identically after their role/scope gates.
- Invisible or cancelled approval requests cannot leave a run waiting indefinitely.
- Focused tests, full tests, typecheck, build, and manual acceptance all pass.
