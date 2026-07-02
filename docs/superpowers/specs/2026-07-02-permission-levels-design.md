# Permission Levels & Interactive Approval Design

## Overview
This design implements a workspace-specific permission system for Claude Code that allows users to seamlessly control how and when the AI executes commands via an intelligent approval pipeline. It fulfills the requirement for different access levels per workspace while minimizing UX friction for "safe" and repetitive tasks.

## Architecture & Data Flow

### 1. Workspace Configuration Layer
The primary switch (the 3 modes) will be stored at the workspace level, either via a `.claude/config.json` inside the project folder, or within the central application database that maps workspace paths to their settings.

Users can choose between 3 modes for the current workspace:
- **ask (请求批准)**: High security. Ask before any file modification or network request.
- **auto-approve-safe (替我审批)**: Normal operation. Silently run read/status operations, but intercept destructive or unverified activities based on a risk assessment.
- **full-access (完全访问权限)**: AI operates autonomously without interruption.

### 2. Rule Engine (The Whitelist System)
Under the hood, a rules engine sits between the AI's requested tool actions and the actual operation execution.
- Rules are matched via lightweight globbing/regex (e.g., matching `npm install *` against `npm install react`).
- **Rule Scope**: 
  - `session`: Kept in an in-memory Set/Map, discarded when the app restarts.
  - `global`: Stored in a global configuration file (e.g., `~/.claude/global-permissions.json`), applied across all workspaces.

### 3. Smart Prompting Interface (The "Option B" Approach)
When the active permission mode dictates that an action requires approval, or the action contains risk flags without a matching rule, the UI intercepts and presents an Approval Dialog.

**Dialog Breakdown:**
- **Action Context**: "Claude wants to run `npm install axios`"
- **Scope Options (Radio buttons intelligently generated)**:
   - 🔘 `npm install axios` (Match exact command)
   - 🔘 `npm install *` (Match sub-commands)
   - 🔘 `npm *` (Match all binary usage)
- **Duration/Persistence (Dropdown or segmented control)**:
   - "Just this once" (Fire & forget)
   - "For this session" (Saved in memory)
   - "Always across all projects" (Saved to global file)

## Implementation Steps

1. **Workspace Data Migration**: Define and scaffold a `workspaceSettings` table or JSON mapping so a workspace can load whether it is `ask` / `auto` / `full`.
2. **Whitelist Engine Setup**: Create a `PermissionRuleStore` capable of registering string/wildcard patterns and matching incoming shell strings.
3. **Risk Analyzer Hook**: In `PermissionManager.ts`, inject the filter that evaluates the operation string against the selected workspace mode. If it fails the threshold and isn't whitelisted, it emits an `interception_event`.
4. **UI Refactoring - The Settings Dropdown**: Update the `PromptArea` to allow the user to toggle the 3 modes. Replace the static `请求批准` button with an active state button summarizing the current workspace access level.
5. **UI Refactoring - The Intercept Modal**: Build the `SmartApprovalWidget`. It parses the intercepted command, generates the logical tier options (`cmd exact`, `cmd subcommand *`, `cmd *`), and submits the combination of *rule string + duration* back to the `PermissionRuleStore`.

## Error Handling & Edge Cases
- **Simultaneous Executions**: Ensure the rule engine is thread-safe or uses an asynchronous lock if multiple parallel agent invocations trigger permissions at the same time.
- **Malicious Wildcards**: Ensure escaping rules prevent overly broad or destructive manual entry if users ever tamper with the config file directly (e.g., blocking `* * *` wildcards where the binary itself is dynamic).
