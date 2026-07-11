# Package Manager Version Permission Design

## Problem

PowerShell compound commands such as `node -v; npm -v; pnpm -v; yarn -v; cargo -v` are incorrectly classified as L4. `NestedCommandExpander` treats the version flag passed to npm-compatible package managers as a package script name, returns `unknown-script`, and `PermissionManager` upgrades that opaque result to `critical.hidden.dynamic-command`.

## Decision

Treat the exact, case-sensitive `-v`, `--version`, and `-version` forms as direct package-manager version queries only when no additional arguments follow. `NestedCommandExpander` must return no nested command and no `opaqueReason` for these invocations. The existing `classifyKnownCommand` logic then classifies them as L0 read-only version queries. Do not include the bare `version` subcommand because commands such as `npm version` and `yarn version` can modify project metadata and Git state.

This change belongs in the expander rather than the UI or the final risk mapper because the command is statically understood and should never become an opaque nested command. Unknown package scripts, missing script names, encoded commands, and dynamically constructed commands keep their existing behavior.

## Verification

- Unit test the expander with npm, pnpm, yarn, and bun version forms.
- End-to-end test the reported PowerShell compound command through `PermissionManager` and assert L0, non-critical, and allowed behavior.
- Verify bare `version`, case variants, trailing arguments, and unknown scripts remain opaque and L4.
- Keep the existing package-script expansion test passing.
