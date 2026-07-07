# Task Capsule Theme Colors Design

## Goal

Make the Task capsule and expanded task card match the current light and dark themes, especially in dark mode where the card currently falls back to a white surface.

## Current Problem

`TaskCapsule.css` uses variables such as `--surface-elevated`, `--text-primary`, `--text-secondary`, and `--text-tertiary`. The app's global theme tokens are mainly `--bg-panel`, `--bg-hover`, `--text-main`, `--text-muted`, `--text-light`, `--primary-color`, and `--border-color`. When those component variables are missing, the Task card falls back to hard-coded light colors.

## Selected Approach

Use the existing app theme tokens directly in `TaskCapsule.css`.

- Surfaces use `--bg-panel`.
- Text uses `--text-main`, `--text-muted`, and `--text-light`.
- Active/progress color uses `--primary-color`.
- Borders use `--border-color`.
- Dark mode gets a small `.dark` shadow adjustment so the floating card keeps depth without looking like a light panel.

## Scope

Only `src/renderer/src/components/chat/TaskCapsule.css` and a focused CSS contract test are in scope. React behavior, task ordering, task content, and positioning are unchanged.

## Acceptance Criteria

- The collapsed Task capsule no longer relies on missing light-theme fallback variables.
- The expanded Task popover uses theme surface and text tokens.
- In dark mode, the popover renders as a dark panel aligned with the app theme.
- Existing task status colors remain readable.

## Self Review

- No placeholders remain.
- The scope is limited to styling and a CSS contract test.
- The acceptance criteria match the selected approach.
