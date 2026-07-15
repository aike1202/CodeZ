# Model-Directed Tool Approval

## 1. Goal

Reduce manual permission interruptions in CodeZ while preserving a small, runtime-enforced safety boundary.

Every tool that may cause side effects exposes one common model-facing parameter:

```ts
approval: 'auto' | 'user'
```

The model uses this parameter to decide whether an operation needs user approval. In full-access mode, `auto` normally executes without a prompt and `user` requests approval. A narrowly defined absolute-redline policy always requires approval and cannot be bypassed by the model.

## 2. Scope

This design applies uniformly to:

- Built-in tools, including shell, file mutation, rollback, network, notification, delegation, and execution control tools.
- Deferred tools activated during a session.
- MCP and plugin tools that are not provably read-only.
- Main-agent and subagent tool calls.

Provably read-only tools do not expose the parameter. Unknown tools and MCP/plugin tools without an authoritative read-only declaration are treated as potentially effectful and must expose it.

The runtime can enforce redlines only over tool input and effects observable by CodeZ. An MCP or plugin that conceals its real remote behavior is outside this guarantee; its call still requires an explicit model preference, but CodeZ cannot classify undisclosed server-side actions.

This design does not replace shell parsing, effect planning, explicit permission rules, input snapshot revalidation, or the permission audit log.

## 3. Shared Contract

Add a shared approval preference type:

```ts
export type ToolApprovalPreference = 'auto' | 'user'
```

The canonical runtime injects the following required property into model-facing schemas for effectful tools:

```json
{
  "approval": {
    "type": "string",
    "enum": ["auto", "user"],
    "description": "Choose user only when this operation materially needs explicit user approval; otherwise choose auto."
  }
}
```

The property is required. Missing or invalid values fail tool input validation and return a recoverable structured error to the model. CodeZ must not turn schema errors into approval prompts.

The approval value is runtime control metadata. It is extracted before effect planning and removed before the underlying built-in, MCP, or plugin handler receives its input.

## 4. Schema Decoration

Approval schema decoration belongs in the canonical tool registration/exposure path, not in individual tool implementations. This gives all tool sources the same behavior and prevents new tools from silently omitting the control.

`ToolDescriptor` gains static approval metadata independent of its input-dependent `behavior.readOnly(input)` function:

```ts
approval: {
  modelPreference: 'not-applicable' | 'required'
}
```

Built-in adapters mark only provably read-only tools as `not-applicable`. MCP, plugin, unknown, and any input-dependent tool default to `required`. Making this field mandatory in the descriptor type forces each new adapter to choose explicitly.

The decorator follows these rules:

1. Tools marked `modelPreference: 'not-applicable'` retain their original schema.
2. All other tools receive the required `approval` property.
3. A schema that already defines a conflicting `approval` property is rejected during registration rather than silently overwritten.
4. Descriptor versions and catalog fingerprints include the decorated schema.
5. Provider-specific tool schemas are compiled from the decorated canonical descriptor.

The runtime stores the extracted value separately from business input, for example as `PreparedToolCall.approvalPreference`. Effect planners, resource-key planners, and handlers receive business input without the control field.

## 5. Decision Order

Permission decisions use this precedence:

1. Explicit deny rule: deny without an approval prompt.
2. Absolute-redline rule: require user approval.
3. Model preference `user`: require user approval.
4. Model preference `auto`: apply the active permission mode.
5. Revalidate input snapshots immediately before execution.

The mode matrix is:

| Condition | Auto mode | Full-access mode |
| --- | --- | --- |
| Explicit deny | Deny | Deny |
| Absolute redline | Ask user | Ask user |
| Model chooses `user` | Ask user | Ask user |
| Model chooses `auto` | Use existing permission rules | Allow |

In auto mode, the model preference can increase caution but cannot bypass an existing runtime `ask` or `deny` decision. In full-access mode, `auto` bypasses normal `ask` decisions but not explicit deny rules or absolute redlines.

## 6. Absolute Redlines

The following operations always require explicit user approval before execution:

- Formatting a filesystem, modifying disk partitions, or writing directly to a block device.
- Deleting a disk root, operating-system directory, user home directory, or the entire workspace.
- Shutting down or rebooting the host, and fork-bomb behavior.
- Requesting administrator or root privileges.
- Modifying operating-system accounts, groups, security policy, or firewall policy.
- Creating, deleting, or reconfiguring system services or startup persistence.
- Modifying credentials, private keys, authentication files, or package-manager tokens.
- Modifying CodeZ permission rules or the workspace permission store.

These redlines remain runtime-owned. Prompt text, tool descriptions, the model preference, stored allow rules, hooks, plugins, and MCP metadata cannot downgrade a redline detected from CodeZ-observable input or effects.

The following operations are no longer unconditional hardline prompts. They follow the model preference and the normal mode matrix:

- Force pushing, including `--force-with-lease`.
- Fetching remote content and immediately executing it.
- Encoded commands, dynamically generated commands, and hidden nested execution.
- Starting, stopping, or restarting an existing system service.

Creating, deleting, or reconfiguring a service remains an absolute redline.

## 7. Model Guidance

The parameter description and system tool policy instruct the model to choose:

- `auto` for routine edits, builds, tests, and operations whose intent and impact are understood.
- `user` for irreversible operations, external publication, actions that may affect user data, or operations whose intent remains ambiguous.

The guidance explicitly tells the model not to select `user` for every side-effecting call merely to defer responsibility. Runtime redlines remain the authoritative protection for the small set of operations that must always be surfaced.

## 8. Data Flow

```text
Canonical tool descriptor
  -> approval schema decoration
  -> provider tool definition
  -> model tool call
  -> canonical input validation
  -> extract approval preference
  -> strip runtime control field
  -> effect planning and permission evaluation
  -> deny / ask user / execute
  -> snapshot revalidation
  -> tool handler
  -> audit record
```

Subagents use the same canonical descriptors and authorization path. When a subagent requests user approval, the existing request carries its agent identity so the UI can identify the source.

## 9. Approval UI and Audit

The approval card distinguishes:

- Model-requested approval.
- Runtime-forced absolute-redline approval.

The request shows the tool, effective reason, analyzed impacts, and the originating agent. Existing approval scopes remain available for model-requested normal operations. Absolute-redline approvals remain one-time only.

Audit records include:

- The model's requested approval preference.
- The effective action and active permission mode.
- Whether an explicit rule or absolute redline overrode the preference.
- The decisive rule ID.
- Main-agent or subagent identity.
- The user response when approval was requested.

The audit record must not copy secrets from tool input beyond the repository's existing redaction policy.

## 10. Error Handling

- Missing or invalid `approval`: return a recoverable input-validation error; do not execute and do not open an approval card.
- Approval UI unavailable: deny operations that require approval; never silently allow them.
- Explicit deny: return a structured denied result containing the decisive rule ID.
- Conflicting tool schema: reject tool registration with an actionable error.
- Effect-plan or parser failure: preserve current fail-safe behavior in auto mode; in full-access mode, follow `approval: auto` unless an absolute-redline detector matches.
- Input snapshot mismatch: deny execution and require a fresh tool call.
- Approval cancellation or renderer loss: resolve the pending request as denied so the agent does not wait forever.

## 11. Migration

This is a schema-breaking change for effectful tool calls. No persisted permission-mode migration is required; workspaces keep their current `auto` or `full-access` value.

During rollout:

1. Decorate canonical schemas and update schema baselines.
2. Add runtime extraction and stripping before changing permission decisions.
3. Split existing hardline rules into absolute-redline and model-directed categories.
4. Update the prompt policy and approval UI labels.
5. Enable the new decision matrix for main agents and subagents together.

Old or malformed tool calls that omit the parameter fail validation and are returned to the model for correction. They are not silently defaulted because a hidden default would undermine the requirement that the model make an explicit choice.

## 12. Verification

Automated coverage must include:

- Schema decoration for built-in, deferred, plugin, and MCP tools.
- No decoration for provably read-only tools.
- Registration failure for a conflicting schema property.
- Validation failure for missing and invalid values.
- Removal of `approval` before built-in and MCP handler execution.
- The complete auto/full-access decision matrix.
- Explicit deny precedence.
- Every absolute-redline category overriding `approval: auto`.
- Former hardline categories following the model preference.
- Main-agent and subagent parity.
- Approval UI source labels and one-time-only absolute-redline options.
- Approval-handler loss and renderer cancellation resolving as denial.
- Permission audit fields and redaction behavior.
- Existing permission, command parser, effect-plan, tool runtime, and subagent regression suites.

Manual verification should exercise a full-access session containing routine edits, builds, network operations, a model-requested approval, a force push dry-run or mocked equivalent, and representative absolute-redline commands intercepted before execution.

## 13. Acceptance Criteria

- Full-access work can continue unattended when the model chooses `auto` and no absolute redline is present.
- The model can deliberately request user approval for any effectful operation.
- Auto mode retains its existing runtime restrictions and cannot be weakened by the model.
- Absolute-redline operations always wait for explicit user approval before execution.
- Missing approval parameters never cause an approval popup or silent execution.
- All tool sources and agent roles use the same contract and decision path.
- Audit data explains why each operation was allowed, denied, or surfaced to the user.
