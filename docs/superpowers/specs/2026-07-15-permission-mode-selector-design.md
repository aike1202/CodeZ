# Permission Mode Selector Design

## Goal

Replace the native permission-mode `<select>` in the prompt composer with a compact, CodeZ-themed listbox inspired by ChatGPT's approval-mode menu. The change is local to `PermissionModeSelector`; shared selects and settings screens remain unchanged.

## Closed State

- Render a quiet toolbar button showing the active mode label and a chevron.
- Match the prompt composer's compact control height and neutral surface treatment.
- Avoid a persistent blue border; use a restrained hover state and a visible keyboard focus ring.
- Disable the control when no workspace is open.

## Open State

- Open a menu above the trigger so it does not collide with the bottom edge of the composer.
- Show two rows: `自动` and `完全访问`.
- Each row contains a Lucide icon, a title, a concise description, and a check icon for the selected mode.
- Use a subtle neutral background for the selected row instead of the operating system's bright blue selection.
- Adapt through existing theme variables for both light and dark themes.
- Keep the menu compact, with an 8px-or-less radius and no nested cards.

## Copy

- `自动`: `常规操作直接执行，风险操作按权限策略确认`
- `完全访问`: `尽可能自动执行；模型可请求确认，绝对红线始终询问`

## Interaction And Accessibility

- Implement the trigger as a button and the popup as a single-select listbox.
- Support click selection, Arrow Up/Down, Home/End, Enter/Space, and Escape.
- Close on outside click, selection, or focus leaving the menu.
- Return focus to the trigger after Escape or selection.
- Expose the active option through `aria-selected` and connect the trigger to the listbox through ARIA attributes.
- Persist changes through the existing `setPermissionMode` store action; no permission behavior changes are part of this work.

## Components And Styling

- Keep state and interaction logic inside `PermissionModeSelector.tsx` because the two-option menu is specific to permission semantics.
- Add local `prompt-permission-*` styles to `PromptArea.css`, reusing existing design tokens and popup layering conventions.
- Use existing Lucide React icons; do not add assets or dependencies.
- Do not modify the shared `Select` component.

## Failure Handling

- Show the newly selected mode immediately through the store's existing optimistic update.
- Prevent repeated selection while an update is pending.
- If persistence fails, rely on the store's existing rollback to restore the previous mode; close the menu without introducing a new global notification system.

## Verification

- Add focused component or interaction tests where the current test setup supports them.
- Run type checking and relevant tests.
- Verify the open and closed states visually in dark and light themes, including narrow composer widths.
- Verify keyboard navigation, outside-click dismissal, disabled state, and selected-mode persistence.
