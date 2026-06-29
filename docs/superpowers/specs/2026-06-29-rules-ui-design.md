# Agent Rules UI Management Design Spec

## Overview
A unified interface within the `SettingsPage` to manage both Global Rules and Project (Workspace) Rules. This UI enables users to easily view, create, edit, and delete rules that dictate the behavior of the AI Coding Agent, adopting standard metadata parameters (YAML Frontmatter) combined with Markdown content.

## Scope
- Frontend: New `SettingsRulesTab` component integrated into the existing `SettingsPage`.
- Backend (Main Process): New IPC handlers to perform CRUD operations on rule files.
- File System: Read and write rules from/to `~/.codez/rules/*.md` (Global) and `<workspace>/.codez/rules/*.md` (Project), along with fallback support for root `AGENTS.md` or `.clinerules`.

*Note: Dynamically filtering system prompts via `globs` during chat runtime is out-of-scope for this UI-focused task and will be handled in a separate iteration.*

## Architecture & Data Flow

### 1. File Structure & Format
Rules will follow the `.mdc` style format consisting of YAML Frontmatter and Markdown body.

```markdown
---
description: [Short description of rule intent]
globs: [File patterns, e.g., src/**/*.tsx]
alwaysApply: true/false
---
# Rules content
...
```

### 2. Frontend UI Components
- **Sidebar (Left Panel)**: 
  - Collapsible groups for "🌐 Global Rules" and "📁 Workspace Rules".
  - A persistent "+ Add Rule" button to create new rules.
- **Editor Panel (Right Panel)**:
  - Form fields for metadata: `Filename`, `Description`, `Globs` (comma-separated), `Always Apply` (toggle).
  - A Markdown editor (`textarea` or code editor component) for the rule body.
  - "Save" and "Delete" actions.

### 3. IPC Handlers
New handlers to be added (e.g., in `workspace.handlers.ts` or a new `rules.handlers.ts`):
- `ipcMain.handle('workspace:get-rules-list', async () => {...})`: Returns a categorized list of all parsed rules.
- `ipcMain.handle('workspace:save-rule', async (_, scope, filename, content) => {...})`: Assembles YAML frontmatter and markdown, saves to appropriate directory.
- `ipcMain.handle('workspace:delete-rule', async (_, scope, filename) => {...})`: Deletes the file from the filesystem.

### 4. Error Handling
- Invalid YAML syntax in existing files will be caught; the system will fall back to treating the entire file as markdown content without metadata.
- Attempts to save with an empty filename will show a validation error in the UI.

## Testing Strategy
- Manual verification: Create a global rule and a project rule via UI, then verify the physical files are created correctly in `~/.codez/rules/` and `.codez/rules/`.
- Verify the content formatting matches the YAML Frontmatter specification.
