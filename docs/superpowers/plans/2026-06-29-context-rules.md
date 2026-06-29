# Context Rules & Global Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a rules scanning and injection mechanism that reads project-specific and global rule files (like `.codez/rules/*.md`, `~/.codez/rules/*.md`, `AGENTS.md`) and injects them into the agent's system prompt during initialization.

**Architecture:** We will create a `RulesResolver` class responsible for reading file paths asynchronously, handling missing files gracefully, scanning directories for markdown files, and concatenating all found rules into a single comprehensive string. This string will then be retrieved by `chat.handlers.ts` and injected into the `<repository_instructions>` or `<rules>` block.

**Tech Stack:** TypeScript, Node.js (fs/promises, path, os), Vitest (for testing).

## Global Constraints

- Must run asynchronously without blocking the main process thread.
- Treat file loading as fail-safe (if a file or directory does not exist, ignore and continue).
- Output rules grouped logically (e.g. Workspace Rules, Global Rules).
- Use `fs.promises` instead of synchronous `fs` methods.

---

### Task 1: Create RulesResolver Test

**Files:**
- Create: `src/tests/rules-resolver.test.ts`

**Interfaces:**
- Consumes: None
- Produces: A failing test suite for `RulesResolver.getRules(workspaceRoot)`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as os from 'os'
import { RulesResolver } from '../main/agent/RulesResolver'

describe('RulesResolver', () => {
  const mockWorkspace = path.join(__dirname, 'mock_workspace')
  const mockHomeDir = path.join(__dirname, 'mock_home')

  beforeEach(async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(mockHomeDir)
    await fs.mkdir(mockWorkspace, { recursive: true })
    await fs.mkdir(mockHomeDir, { recursive: true })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(mockWorkspace, { recursive: true, force: true })
    await fs.rm(mockHomeDir, { recursive: true, force: true })
  })

  it('should load global and workspace rules and concatenate them', async () => {
    // Setup workspace rules
    await fs.writeFile(path.join(mockWorkspace, 'AGENTS.md'), 'Workspace Agent Rule')
    const codezRulesDir = path.join(mockWorkspace, '.codez', 'rules')
    await fs.mkdir(codezRulesDir, { recursive: true })
    await fs.writeFile(path.join(codezRulesDir, 'test-rule.md'), 'Workspace Custom Rule')

    // Setup global rules
    const globalCodezRulesDir = path.join(mockHomeDir, '.codez', 'rules')
    await fs.mkdir(globalCodezRulesDir, { recursive: true })
    await fs.writeFile(path.join(globalCodezRulesDir, 'global-test-rule.md'), 'Global Custom Rule')

    const rules = await RulesResolver.getRules(mockWorkspace)
    
    expect(rules).toContain('Workspace Agent Rule')
    expect(rules).toContain('Workspace Custom Rule')
    expect(rules).toContain('Global Custom Rule')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/tests/rules-resolver.test.ts`
Expected: FAIL with "Cannot find module '../main/agent/RulesResolver'"

- [ ] **Step 3: Write minimal implementation**

Create `src/main/agent/RulesResolver.ts` with empty logic to fix the import error.

```typescript
export class RulesResolver {
  static async getRules(workspaceRoot: string): Promise<string> {
    return ''
  }
}
```

- [ ] **Step 4: Run test to verify it fails on assertion**

Run: `npm run test -- src/tests/rules-resolver.test.ts`
Expected: FAIL on `expect(rules).toContain('Workspace Agent Rule')`

- [ ] **Step 5: Commit**

```bash
git add src/tests/rules-resolver.test.ts src/main/agent/RulesResolver.ts
git commit -m "test: add failing tests for RulesResolver"
```

---

### Task 2: Implement RulesResolver

**Files:**
- Modify: `src/main/agent/RulesResolver.ts`

**Interfaces:**
- Consumes: `RulesResolver` signature from Task 1.
- Produces: Fully functional `RulesResolver.getRules` method.

- [ ] **Step 1: Write the implementation**

Replace contents of `src/main/agent/RulesResolver.ts` to implement the loading logic:

```typescript
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

export class RulesResolver {
  static async getRules(workspaceRoot: string): Promise<string> {
    let combinedRules = ''

    // 1. Global Rules
    const globalRules: string[] = []
    const homeDir = os.homedir()
    
    // Global ~/.codez/AGENTS.md
    globalRules.push(await this.safeReadFile(path.join(homeDir, '.codez', 'AGENTS.md')))
    // Global ~/.codez/rules/*.md
    globalRules.push(await this.readMarkdownFilesInDir(path.join(homeDir, '.codez', 'rules')))

    const filteredGlobal = globalRules.filter(Boolean)
    if (filteredGlobal.length > 0) {
      combinedRules += '=== Global Rules ===\n' + filteredGlobal.join('\n\n') + '\n\n'
    }

    // 2. Workspace Rules
    const workspaceRules: string[] = []
    
    workspaceRules.push(await this.safeReadFile(path.join(workspaceRoot, 'AGENTS.md')))
    workspaceRules.push(await this.safeReadFile(path.join(workspaceRoot, '.agents', 'AGENTS.md')))
    workspaceRules.push(await this.safeReadFile(path.join(workspaceRoot, '.clinerules')))
    workspaceRules.push(await this.safeReadFile(path.join(workspaceRoot, '.cursorrules')))
    // Workspace .codez/rules/*.md
    workspaceRules.push(await this.readMarkdownFilesInDir(path.join(workspaceRoot, '.codez', 'rules')))

    const filteredWorkspace = workspaceRules.filter(Boolean)
    if (filteredWorkspace.length > 0) {
      combinedRules += '=== Workspace Rules ===\n' + filteredWorkspace.join('\n\n') + '\n\n'
    }

    return combinedRules.trim()
  }

  private static async safeReadFile(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      return content.trim() ? `[Source: ${path.basename(filePath)}]\n${content.trim()}` : ''
    } catch {
      return ''
    }
  }

  private static async readMarkdownFilesInDir(dirPath: string): Promise<string> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      let contents = ''
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const content = await this.safeReadFile(path.join(dirPath, entry.name))
          if (content) contents += content + '\n\n'
        }
      }
      return contents.trim()
    } catch {
      return ''
    }
  }
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm run test -- src/tests/rules-resolver.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/agent/RulesResolver.ts
git commit -m "feat: implement RulesResolver logic for global and workspace rules"
```

---

### Task 3: Integrate RulesResolver into chat.handlers.ts

**Files:**
- Modify: `src/main/ipc/chat.handlers.ts`

**Interfaces:**
- Consumes: `RulesResolver.getRules(currentWorkspace)`
- Produces: Updated system prompt in `registerChatIpc` that includes the dynamically resolved rules.

- [ ] **Step 1: Write implementation**

Modify `src/main/ipc/chat.handlers.ts`. Find the block that loads `AGENTS.md` (around line 93):

```typescript
      // 自动加载本地全局规则 (属于 Repository Instructions)
      const agentsMdPath = path.join(currentWorkspace, 'AGENTS.md')
      if (fs.existsSync(agentsMdPath)) {
        try {
          const rulesContent = fs.readFileSync(agentsMdPath, 'utf-8')
          systemPrompt += `<repository_instructions>\n${rulesContent}\n</repository_instructions>\n\n`
        } catch (e) {
          console.error('Failed to read AGENTS.md', e)
        }
      }
```

Replace it with:

```typescript
      // 动态加载项目和全局规则
      try {
        const { RulesResolver } = await import('../agent/RulesResolver')
        const rulesContent = await RulesResolver.getRules(currentWorkspace)
        if (rulesContent) {
          systemPrompt += `<repository_instructions>\n${rulesContent}\n</repository_instructions>\n\n`
        }
      } catch (e) {
        console.error('Failed to resolve rules via RulesResolver', e)
      }
```

- [ ] **Step 2: Run the tests to ensure no regressions**

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/chat.handlers.ts
git commit -m "feat: use RulesResolver to inject workspace and global rules into system prompt"
```
