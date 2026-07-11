# Pattern Permission With Hardline Design

## 1. Goal

Replace risk-level-driven approval decisions with a MiMo Code/OpenCode-style `allow` / `ask` / `deny` permission-pattern model while retaining a non-bypassable Hardline layer for genuinely extreme operations.

The design fixes two systemic problems:

- Analysis uncertainty such as an unreadable package script must not be labeled "extremely dangerous".
- A superficial token such as `--version` must not downgrade a command that installs, deploys, executes, deletes, or otherwise has side effects.

## 2. Non-Goals

- Do not remove the existing `riskLevel` field from persisted messages or audit records in this change. It remains compatibility metadata and no longer drives execution.
- Do not add an operating-system sandbox.
- Do not add a settings editor for manually authoring wildcard rules.
- Do not redesign unrelated task risk fields.

## 3. Selected Model

Permission evaluation has two layers in strict order:

1. `CriticalOperationGuard` detects Hardline operations. Hardline always asks, cannot be remembered, and cannot be bypassed by a broad allow rule.
2. Normal permission checks are evaluated as `allow`, `ask`, or `deny` against mode defaults and remembered wildcard rules.

Risk levels remain descriptive metadata:

- L0/L1 metadata for ordinary allowed work.
- L2/L3 metadata for normal permission prompts.
- L4 only for Hardline.

`PermissionDecisionEngine` must never derive an action from `riskLevel`.

## 4. Permission Capabilities

```ts
export type PermissionCapability =
  | 'read'
  | 'edit'
  | 'shell'
  | 'shell_unparsed'
  | 'network'
  | 'external_effect'
  | 'external_directory'
  | 'delete'
  | 'rollback'
  | 'unknown'
  | 'hardline'
```

Each normal decision contains one or more checks:

```ts
export interface PermissionCheck {
  permission: PermissionCapability
  pattern: string
  action: PermissionAction
  reason: string
}
```

The final decision also records:

```ts
analysisStatus: 'parsed' | 'unparsed'
hardline: boolean
checks: PermissionCheck[]
```

The existing `critical` field remains as a compatibility alias for `hardline`.

## 5. Default Rules

### Auto Mode

| Capability | Default |
| --- | --- |
| `read` | allow |
| `edit` | allow |
| `shell` | allow |
| `network` | ask |
| `external_effect` | ask |
| `external_directory` | ask |
| `delete` | ask |
| `rollback` | ask |
| `shell_unparsed` | ask |
| `unknown` | ask |
| `hardline` | forced ask |

### Full Access Mode

Every normal capability defaults to `allow`. Explicit remembered `deny` rules still apply. Hardline remains forced ask.

## 6. Rule Matching

Remembered rules are keyed by:

- normalized workspace
- optional session ID
- permission capability
- pattern
- action

Patterns support `*` as a wildcard matching any character sequence. All other regex metacharacters are treated literally.

Rules are evaluated in this order:

1. Mode default.
2. Workspace rules in stored order.
3. Session rules in stored order.

The last matching remembered rule wins. Hardline is evaluated outside this rule engine and therefore cannot be overridden.

The first implementation remembers exact command patterns. Wildcard matching is supported for existing or future manually managed rules, but the approval UI does not automatically generate broad prefixes.

## 7. Shell Evaluation

Shell evaluation follows this flow:

1. Reject an empty command as `deny` with `shell_unparsed`; do not label it Hardline.
2. Run `CriticalOperationGuard.analyzeRaw` before ordinary rules.
3. Parse the command with `ShellAnalysisService`.
4. Convert every visible AST command node into an independent permission check.
5. Classify each operation as `shell`, `network`, `external_effect`, or `delete` using executable-specific command-family rules.
6. If the syntax tree contains diagnostics, add a `shell_unparsed` check for the complete command.
7. Expand package scripts and local scripts only for Hardline scanning and snapshot revalidation.
8. If expansion fails, set `analysisStatus: 'unparsed'` and add a `shell_unparsed` check; never create Hardline solely from expansion failure.
9. Aggregate checks: any deny wins; otherwise any ask wins; otherwise allow.

Compound Bash, PowerShell, and cmd commands therefore require every visible operation to be allowed independently.

## 8. Command Classification

`classifyKnownCommand` continues to produce compatibility risk metadata, but it also returns a permission capability.

Side-effect command families are checked before version queries:

- dependency installation and package changes → `network` or `external_effect`
- Git network operations → `network`
- container, cluster, and deployment tools → `external_effect`
- file deletion → `delete`
- ordinary development and read-only shell commands → `shell`

A version query is recognized only when the entire argv shape is a known pure version query. Examples include:

- `npm --version`
- `pnpm -v`
- `go version`
- `java -version`
- `rustc --version`

The following are not version queries:

- `npm version`
- `cargo install ripgrep --version 14.1.0`
- `docker run node:22 --version`
- `npm -v unexpected`

## 9. Package Script Expansion

Package script expansion is not an approval classifier.

- Successfully resolved scripts are scanned recursively for Hardline patterns.
- The package file hash is attached for execution-time revalidation.
- Missing scripts, unreadable package files, unsupported option layouts, and depth overflow become `shell_unparsed`.
- These conditions use ordinary mode rules and are never red Hardline warnings by themselves.

The expander should recognize common package-manager directory options before the script name:

- `npm --prefix <dir> run <script>`
- `pnpm -C <dir> <script>` and `pnpm --dir <dir> <script>`
- `yarn --cwd <dir> <script>`
- `bun --cwd <dir> run <script>`

## 10. Hardline

Hardline includes only operations with direct evidence of extreme impact or concealment:

- deleting a system root, home directory, or entire workspace
- formatting or partitioning disks and raw block-device writes
- administrator/root privilege escalation
- modifying system services, accounts, security policy, or CodeZ permission configuration
- modifying credential or startup-persistence locations
- force-pushing remote history
- downloading content and directly executing it
- encoded/decoded execution and command strings hidden through dynamic generation
- host shutdown/reboot and fork bombs

Parser failures, unknown commands, missing scripts, unreadable scripts, and nesting depth overflow are not Hardline.

Hardline requests:

- expose only `once` approval
- never write an allow rule
- remain red and labeled `极度危险`

## 11. Non-Shell Tools

- Read-only tools create an allowed `read` check.
- Workspace writes create an `edit` check.
- Writes outside the workspace create an `external_directory` check.
- Sensitive credential/config writes return Hardline.
- WebSearch/WebFetch create `network` checks.
- Rollback creates a `rollback` check.
- Unknown tools create an `unknown` check.

## 12. UI

The approval widget stops displaying `L2` or `L3` as the primary label.

- Hardline: red `极度危险`.
- Unparsed normal request: amber `无法完整分析`.
- Other normal request: `需要授权`.

The widget lists the permission capability and matched pattern for every check that requires approval.

Approval scopes are based on `hardline`, not `riskLevel`:

- Hardline: once only.
- Normal asks: once, session, workspace.

## 13. Error Handling

- Parser initialization failure: `shell_unparsed` using mode defaults.
- AST syntax diagnostics: preserve visible checks and add `shell_unparsed`.
- Smart approval unavailable: no effect on normal permission evaluation; the static pattern engine remains authoritative.
- Rule file corruption: ignore corrupted workspace rules and use mode defaults.
- Snapshot mismatch: refuse execution and require reevaluation.

## 14. Migration

Existing stored rules without a `permission` field are interpreted as `shell` exact-pattern rules.

Existing decisions keep `riskLevel` and `critical` so old renderer state and audit entries remain readable. New decisions additionally contain `permission`, `checks`, `analysisStatus`, and `hardline`.

The previous package-manager version hotfix remains compatible but is no longer relied on for approval safety.

## 15. Verification

Tests must cover:

- default actions for every capability in both modes
- wildcard matching and last-match precedence
- session/workspace rule isolation and legacy rule migration
- every compound operation being checked independently
- parser and expansion failures producing normal `shell_unparsed` asks
- exact version queries versus side-effect commands containing `--version`
- package-manager directory options
- Hardline being immune to broad allow rules and persistence
- UI labels and approval scopes
- the existing permission corpus plus MiMo/OpenCode-inspired PowerShell, external-directory, and deletion cases

