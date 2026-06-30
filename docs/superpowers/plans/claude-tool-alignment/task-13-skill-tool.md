### Task 13: Skill 工具（SkillManager.getSkillContent 取正文；未命中列清单）

**Files:**
- Modify: `src/main/services/SkillManager.ts`（新增 `getSkillContent(workspaceRoot, name)` 方法）
- Create: `src/main/tools/builtin/SkillTool.ts`
- Test: `src/tests/skill-tool.test.ts`

**Interfaces:**
- Consumes: `SkillManager.getInstance()` / `getSkills(workspaceRoot)`（`src/main/services/SkillManager.ts`，返回 `SkillDefinition[]`，其中 `content` 即 SKILL.md 正文）；`Tool`/`ToolContext`。
- Produces：
  - `SkillManager.getSkillContent(workspaceRoot: string | null, name: string): Promise<string | null>`：依 `name` 或 `id` 命中则返回 `content`，否则 `null`。
  - `class SkillTool extends Tool`，`name='Skill'`，`parameters_schema={skill(req), args?}`。命中→返回该 SKILL.md 正文；未命中→`Error: skill "<name>" not found. Available:\n- ...`（≤30 项）。
- 后续依赖：Task 15（PermissionManager 将 `Skill`→`allow`）；Task 16（注册）。

**说明：** 保留现有 `<skills_instructions>` prompt 提示与渲染端 `parseSlashCommand` 的 `/<skill>` 内联路径不动；Skill 工具是新增"运行期取正文"通道。`SkillManager.getSkills` 已含 `.content`，无需新扫描逻辑。

- [ ] **Step 1: Write the failing test**

```ts
// src/tests/skill-tool.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { SkillTool } from '../main/tools/builtin/SkillTool'
import { SkillManager } from '../main/services/SkillManager'

let root: string
const SKILL_NAME = 'My Test Skill'

async function setup(): Promise<string> {
  root = path.join(os.tmpdir(), `codez-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const dir = path.join(root, '.skills', 'MyTestSkill')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'),
    `---\nname: ${SKILL_NAME}\ndescription: a test skill\ntriggers: [test-skill]\n---\nThis is the skill body. Follow these instructions.`)
  return root
}

describe('SkillTool', () => {
  beforeEach(async () => { root = await setup() })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

  it('命中 skill：返回正文', async () => {
    const tool = new SkillTool()
    const result = await tool.execute(JSON.stringify({ skill: SKILL_NAME }), { workspaceRoot: root })
    expect(result).toContain('This is the skill body.')
  })

  it('未命中：返 Error 并列出可用清单', async () => {
    const tool = new SkillTool()
    const result = await tool.execute(JSON.stringify({ skill: 'no-such-skill' }), { workspaceRoot: root })
    expect(result.startsWith('Error:')).toBe(true)
    expect(result).toContain('not found')
    expect(result).toContain(SKILL_NAME)
  })

  it('缺 skill：返 Error', async () => {
    const tool = new SkillTool()
    const result = await tool.execute(JSON.stringify({}), { workspaceRoot: root })
    expect(result.startsWith('Error:')).toBe(true)
  })

  it('SkillManager.getSkillContent 命中返回 content，未命中返回 null', async () => {
    const sm = SkillManager.getInstance()
    expect(await sm.getSkillContent(root, SKILL_NAME)).toContain('This is the skill body.')
    expect(await sm.getSkillContent(root, 'no-such')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/skill-tool.test.ts`
Expected: FAIL，`Cannot find module '../main/tools/builtin/SkillTool'` 且 `getSkillContent is not a function`。

- [ ] **Step 3: Add getSkillContent to SkillManager**

在 `src/main/services/SkillManager.ts` 的 `getActiveSkills` 方法之后、`toggleSkill` 之前插入：

```ts
  /** 依 name 或 id 取命中 skill 的正文；未命中返回 null。 */
  public async getSkillContent(workspaceRoot: string | null, name: string): Promise<string | null> {
    const skills = await this.getSkills(workspaceRoot)
    const hit = skills.find(s => s.name === name || s.id === name)
    return hit ? hit.content : null
  }
```

- [ ] **Step 4: Write SkillTool**

```ts
// src/main/tools/builtin/SkillTool.ts
import { Tool, ToolContext } from '../Tool'
import { SkillManager } from '../../services/SkillManager'

interface SkillArgs {
  skill?: string
  args?: string
}

export class SkillTool extends Tool {
  get name() {
    return 'Skill'
  }

  get description() {
    return 'Execute a skill within the main conversation. When users reference /<something> they mean a skill — set skill to the exact name (no leading slash); args for optional arguments. Available skills are listed in system-reminder messages. Only invoke a skill in that list, or one the user explicitly typed as /<name>. Never guess names. When a skill matches the request, this is a BLOCKING REQUIREMENT: invoke the Skill tool BEFORE any other response about the task. Never mention a skill without calling this tool. Do not invoke a skill that is already running. Returns the SKILL.md body for the model to follow.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Exact skill name or id (no leading slash).' },
        args: { type: 'string', description: 'Optional arguments for the skill.' }
      },
      required: ['skill']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as SkillArgs
      if (!parsed.skill) return 'Error: skill is required.'

      const sm = SkillManager.getInstance()
      const content = await sm.getSkillContent(context.workspaceRoot, parsed.skill)
      if (content) return content

      const skills = await sm.getSkills(context.workspaceRoot)
      const list = skills.slice(0, 30).map((s) => `- ${s.name} (${s.id})`).join('\n')
      return `Error: skill "${parsed.skill}" not found. Available:\n${list || '(none)'}`
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/tests/skill-tool.test.ts`
Expected: PASS（4 例全绿）。

- [ ] **Step 6: Commit**

```bash
git add src/main/services/SkillManager.ts src/main/tools/builtin/SkillTool.ts src/tests/skill-tool.test.ts
git commit -m "feat(tools): add Skill tool + SkillManager.getSkillContent"
```
