# 内置技能与技能/规则创建流程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 CodeZ 增加三个随应用分发的内置技能（skill-creator / find-skills / rule-creator），内置技能受保护（不可删、可启停），并让 Skills/Rules 页的"新建"按钮跳转到新会话并预填对应技能的斜杠命令。

**Architecture:** 后端 `SkillManager` 新增内置技能同步与保护逻辑，打包资源经 electron-builder `extraResources` 分发、首启递归复制到 `~/.codez/skills`。前端复用已有的 `pendingPrompt` + `createSession` 机制，通过从 `App` 透传的回调把 `+` 按钮接到"新建会话并预填斜杠命令"。不新增 IPC 通道。

**Tech Stack:** Electron + TypeScript（main 进程 CJS）、React 18 + Zustand（renderer）、electron-vite、electron-builder、vitest。

## Global Constraints

- 内置技能触发名与目录名精确一致且**全小写**：`skill-creator`、`find-skills`、`rule-creator`。
- Skills 页 `+` 预填：`/skill-creator 帮我写一个技能：`
- Rules 页 "AI 帮写" 预填：`/rule-creator 帮我写一条规则：`
- 内置技能作用域为全局：写入 `~/.codez/skills/<name>/`。
- 内置技能升级策略：用打包版本**覆盖**内容；启停开关存 config，不受覆盖影响。
- 内置技能删除：后端 `deleteSkill` 返回 `false` + 前端隐藏删除按钮（双保险）。
- Kotlin 风格规则不适用（本项目为 TS/React）；遵循现有代码风格：2 空格缩进、无分号结尾风格沿用文件现状。
- 无工作区时点 `+`：不建会话，仅 `setPendingPrompt` + 切视图。
- skill-creator 使用 anthropics/skills 官方目录树，原样打包，不改写正文。

---

## File Structure

**后端（main）**
- `src/shared/types/skill.ts` — 修改：`SkillDefinition` 加 `builtin?: boolean`。
- `src/main/services/BuiltinSkills.ts` — 新建：内置技能名集合 + 打包资源根路径解析（dev vs packaged）。
- `src/main/services/SkillManager.ts` — 修改：`scanDir` 标记 builtin；`deleteSkill` 保护；`syncBuiltinSkills` 替换 `initializeGlobalSkillsIfNeeded`。

**打包资源**
- `resources/builtin-skills/skill-creator/**` — 新建：官方完整目录树。
- `resources/builtin-skills/find-skills/SKILL.md` — 新建：提示词。
- `resources/builtin-skills/rule-creator/SKILL.md` — 新建：提示词。
- `package.json` — 修改：`build.extraResources`。

**前端（renderer）**
- `src/renderer/src/App/index.tsx` — 修改：`handleCreateFromSkill` 回调 + 透传。
- `src/renderer/src/pages/SettingsPage.tsx` — 修改：新增 `onCreateFromSkill` prop 并透传。
- `src/renderer/src/components/SettingsSkillsTab.tsx` — 修改：`+` 改新建技能、新增打开文件夹按钮、builtin 隐藏删除。
- `src/renderer/src/components/SettingsRulesTab/index.tsx` — 修改：新增"AI 帮写规则"入口。

**测试**
- `src/tests/skill-manager-builtin.test.ts` — 新建：builtin 标记与删除保护单元测试。

---

## Task 1: `SkillDefinition` 增加 `builtin` 字段

**Files:**
- Modify: `src/shared/types/skill.ts:1-10`

**Interfaces:**
- Consumes: 无
- Produces: `SkillDefinition.builtin?: boolean` 供 Task 2、3、7 使用。

- [ ] **Step 1: 修改类型定义**

在 `src/shared/types/skill.ts` 的 `SkillDefinition` 接口中，在 `isGlobal?: boolean` 之后加入 `builtin` 字段：

```ts
export interface SkillDefinition {
  id: string
  name: string
  description: string
  triggers?: string[]
  content: string
  path?: string
  enabled?: boolean
  isGlobal?: boolean
  /** 系统内置技能：不可删除，但可启用/停用 */
  builtin?: boolean
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: PASS（无新增错误）

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/skill.ts
git commit -m "feat(skill): add builtin flag to SkillDefinition"
```

---

## Task 2: 内置技能名集合与打包资源路径解析

**Files:**
- Create: `src/main/services/BuiltinSkills.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `BUILTIN_SKILL_NAMES: readonly string[]`（值为 `['skill-creator','find-skills','rule-creator']`）
  - `isBuiltinSkillName(name: string): boolean`
  - `resolveBuiltinSkillsDir(): string | null` — 返回打包资源目录 `builtin-skills` 的绝对路径，找不到返回 `null`。

参考现有 `src/main/tools/ripgrepPath.ts` 的 dev/packaged 路径解析写法。main 进程运行期为 CJS，`__dirname` 可用；打包后主进程位于 `out/main/`，`extraResources` 落在 `process.resourcesPath`。

- [ ] **Step 1: 新建文件**

创建 `src/main/services/BuiltinSkills.ts`：

```ts
import * as fs from 'fs'
import * as path from 'path'

/** 系统内置技能目录名（同时也是精确小写触发名） */
export const BUILTIN_SKILL_NAMES = ['skill-creator', 'find-skills', 'rule-creator'] as const

/** 判断给定技能名是否为内置技能 */
export function isBuiltinSkillName(name: string): boolean {
  return (BUILTIN_SKILL_NAMES as readonly string[]).includes(name)
}

/**
 * 解析打包的内置技能资源目录（含 skill-creator/ find-skills/ rule-creator/ 三个子目录）。
 *
 * 优先级：
 * 1. `CODEZ_BUILTIN_SKILLS_DIR` 环境变量（测试覆盖用）。
 * 2. 打包后：`process.resourcesPath/builtin-skills`（electron-builder extraResources）。
 * 3. 开发期：项目根 `resources/builtin-skills`（相对 out/main 主进程为 ../../resources/...）。
 */
export function resolveBuiltinSkillsDir(): string | null {
  if (process.env.CODEZ_BUILTIN_SKILLS_DIR) {
    return process.env.CODEZ_BUILTIN_SKILLS_DIR
  }

  const candidates: string[] = []

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'builtin-skills'))
  }
  // 开发期：out/main/index.js -> 项目根 resources/builtin-skills
  candidates.push(path.join(__dirname, '..', '..', 'resources', 'builtin-skills'))
  // 兜底：cwd
  candidates.push(path.join(process.cwd(), 'resources', 'builtin-skills'))

  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        return dir
      }
    } catch {
      // 忽略无法访问的候选路径
    }
  }
  return null
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/services/BuiltinSkills.ts
git commit -m "feat(skill): add builtin skill names and resource path resolver"
```

---

## Task 3: `SkillManager` 标记 builtin + 删除保护

**Files:**
- Modify: `src/main/services/SkillManager.ts:1-10`（imports）
- Modify: `src/main/services/SkillManager.ts:95-104`（scanDir 构造 skill 对象）
- Modify: `src/main/services/SkillManager.ts:321-347`（deleteSkill）
- Test: `src/tests/skill-manager-builtin.test.ts`

**Interfaces:**
- Consumes: `isBuiltinSkillName`（Task 2）、`SkillDefinition.builtin`（Task 1）
- Produces: `scanWorkspace` 返回的全局技能对象带正确 `builtin` 标记；`deleteSkill` 对 builtin 技能返回 `false`。

- [ ] **Step 1: 写失败测试**

创建 `src/tests/skill-manager-builtin.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

let home: string

async function writeSkill(dir: string, name: string): Promise<void> {
  const skillDir = path.join(dir, name)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test ${name}\n---\nbody`,
    'utf-8'
  )
}

describe('SkillManager builtin', () => {
  beforeEach(() => {
    home = path.join(os.tmpdir(), `codez-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    // 隔离测试：不触发真实内置资源同步
    process.env.CODEZ_BUILTIN_SKILLS_DIR = path.join(home, 'no-such-dir')
    // 重置单例
    ;(SkillManagerModule as any).SkillManager['instance'] = undefined
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    delete process.env.CODEZ_BUILTIN_SKILLS_DIR
    await fs.rm(home, { recursive: true, force: true })
  })

  it('全局技能中命中内置名的被标记 builtin，其余为 false', async () => {
    const globalDir = path.join(home, '.codez', 'skills')
    await writeSkill(globalDir, 'skill-creator')
    await writeSkill(globalDir, 'my-custom')

    const sm = SkillManagerModule.SkillManager.getInstance()
    const skills = await sm.scanWorkspace(null)

    const creator = skills.find((s) => s.id === 'global-skill-creator')
    const custom = skills.find((s) => s.id === 'global-my-custom')
    expect(creator?.builtin).toBe(true)
    expect(custom?.builtin).toBe(false)
  })

  it('deleteSkill 拒绝删除内置技能', async () => {
    const globalDir = path.join(home, '.codez', 'skills')
    await writeSkill(globalDir, 'skill-creator')

    const sm = SkillManagerModule.SkillManager.getInstance()
    await sm.scanWorkspace(null)
    const ok = await sm.deleteSkill(null, 'global-skill-creator')
    expect(ok).toBe(false)

    // 目录仍存在
    const stat = await fs.stat(path.join(globalDir, 'skill-creator'))
    expect(stat.isDirectory()).toBe(true)
  })
})

import * as SkillManagerModule from '../main/services/SkillManager'
```

> 说明：`import` 放末尾是为了让 `vi.spyOn(os,'homedir')` 在模块求值前设置——但 vitest 的 import 会被提升。改为在文件顶部正常 import，并在 `beforeEach` 里 spy。见 Step 3 修正版。

- [ ] **Step 2: 修正测试的 import 顺序并运行确认失败**

把测试文件顶部改为标准 import（删除末尾那行 import，移到顶部）：

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { SkillManager } from '../main/services/SkillManager'
```

并把测试体内 `SkillManagerModule.SkillManager` 全部替换为 `SkillManager`，把重置单例那行改为：

```ts
;(SkillManager as any)['instance'] = undefined
```

Run: `npx vitest run src/tests/skill-manager-builtin.test.ts`
Expected: FAIL（`creator?.builtin` 为 `undefined`，且 `deleteSkill` 返回 `true`——因为保护逻辑尚未实现）

- [ ] **Step 3: 加 import**

在 `src/main/services/SkillManager.ts` 顶部 import 区（第 10 行 `} from '../../shared/types/skill'` 之后）加：

```ts
import { isBuiltinSkillName } from './BuiltinSkills'
```

- [ ] **Step 4: scanDir 标记 builtin**

在 `src/main/services/SkillManager.ts` 的 `scanDir` 中，找到构造 skill 对象的 `skills.push({...})`（约 95-104 行）。先在 `id` 计算之后、`push` 之前，算出裸技能名并判断 builtin。将该段改为：

```ts
            const parentDirName = path.basename(path.dirname(fullPath))
            const fileName = path.basename(entry.name, entry.name === 'SKILL.md' ? '' : '.skill.md')
            const bareName = entry.name === 'SKILL.md' ? parentDirName : fileName
            const id = (isGlobal ? 'global-' : 'workspace-') + bareName

            skills.push({
              id,
              name: nameMatch ? nameMatch[1].trim() : id,
              description: descMatch ? descMatch[1].trim() : '',
              triggers,
              content: body,
              path: fullPath,
              enabled: config[id] !== false,
              isGlobal,
              builtin: isGlobal && isBuiltinSkillName(bareName)
            })
```

- [ ] **Step 5: deleteSkill 保护**

在 `src/main/services/SkillManager.ts` 的 `deleteSkill` 方法中，找到：

```ts
    const target = skills.find((s) => s.id === id)
    if (!target || !target.path) return false
```

在其后立即加入 builtin 保护：

```ts
    const target = skills.find((s) => s.id === id)
    if (!target || !target.path) return false

    // 内置技能受保护：不可删除
    if (target.builtin) {
      console.warn(`Refused to delete builtin skill: ${id}`)
      return false
    }
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run src/tests/skill-manager-builtin.test.ts`
Expected: PASS（两个用例均通过）

- [ ] **Step 7: Commit**

```bash
git add src/main/services/SkillManager.ts src/tests/skill-manager-builtin.test.ts
git commit -m "feat(skill): mark builtin skills and protect them from deletion"
```

---

## Task 4: 打包内置技能资源文件

**Files:**
- Create: `resources/builtin-skills/skill-creator/**`（官方目录树）
- Create: `resources/builtin-skills/find-skills/SKILL.md`
- Create: `resources/builtin-skills/rule-creator/SKILL.md`

**Interfaces:**
- Consumes: 无
- Produces: 打包资源目录，供 Task 5 的 `syncBuiltinSkills` 复制。

- [ ] **Step 1: 获取官方 skill-creator 目录树**

克隆 anthropics/skills 仓库并复制 skill-creator 完整目录到 `resources/builtin-skills/skill-creator/`：

```bash
git clone --depth 1 https://github.com/anthropics/skills /tmp/anthropics-skills
mkdir -p resources/builtin-skills
cp -r /tmp/anthropics-skills/skills/skill-creator resources/builtin-skills/skill-creator
ls resources/builtin-skills/skill-creator
```

Expected: 输出包含 `SKILL.md scripts eval-viewer agents references assets`（或其子集，以官方仓库实际结构为准）。若克隆失败（无网络），改为手动下载 https://www.skills.sh/anthropics/skills/skill-creator 对应仓库目录并放入同一路径。

- [ ] **Step 2: 校验 skill-creator/SKILL.md frontmatter 存在**

Run: `head -5 resources/builtin-skills/skill-creator/SKILL.md`
Expected: 首行是 `---`，含 `name: skill-creator` 与 `description:`。若 `name` 不是 `skill-creator`（例如是 `Skill Creator`），将其改为 `name: skill-creator`（保持目录名与触发名一致，全小写）。

- [ ] **Step 3: 写 find-skills/SKILL.md**

创建 `resources/builtin-skills/find-skills/SKILL.md`：

```markdown
---
name: find-skills
description: 从互联网（GitHub、skills.sh 等）搜索现成的 AI 技能并安装到本地。当用户想要"找一个技能""安装某类技能""有没有现成的 skill 能做 X"，或提到发现、检索、下载、导入技能时，务必使用本技能。
---

# Find Skills（查找并安装技能）

帮用户从网络上找到现成的技能（skill）并安装到本地技能目录。

## 工作流程

### 1. 明确需求
先问清楚用户想要什么技能：解决什么任务、期望的输入/输出、是否偏好某个来源（如 anthropics/skills 官方库）。如果用户已经描述得很清楚，直接进入下一步。

### 2. 搜索候选
使用可用的联网搜索能力（WebSearch / 网页抓取工具）查找候选技能。优先检索：
- `github.com/anthropics/skills` 官方技能库
- `skills.sh` 技能市场
- GitHub 上标注 `SKILL.md` 的仓库

对每个候选，记录：名称、一句话描述、来源 URL、以及 `SKILL.md` 的原始地址。

### 3. 展示并让用户选择
用简洁列表把候选技能呈现给用户（名称 + 描述 + 来源），让用户选择要安装哪一个（或哪几个）。不要擅自安装。

### 4. 询问安装位置
安装前**务必询问用户**装到哪里，给出两个选项：
- **项目级**：写入当前项目的 `.skills/<skill-name>/`（仅本项目可用，随项目走）
- **全局**：写入 `~/.codez/skills/<skill-name>/`（所有项目可用）

如果当前没有打开项目，只能选全局。

### 5. 安装
- 抓取选定技能的 `SKILL.md`（及其引用的脚本/资源文件，若有）。
- 在目标目录下创建 `<skill-name>/` 子目录，写入 `SKILL.md`。若技能带有 `scripts/`、`references/`、`assets/` 等子目录，一并抓取写入，保持相对结构。
- 安装完成后，简要告诉用户技能名、安装位置，以及可以在聊天里用 `/<skill-name>` 触发。

## 注意
- 技能内容可能来自第三方，安装前请核对来源可信，不要安装含有恶意脚本或会泄露数据的技能。
- 目录名即触发名，保持技能原始名称的大小写。
```

- [ ] **Step 4: 写 rule-creator/SKILL.md**

创建 `resources/builtin-skills/rule-creator/SKILL.md`：

```markdown
---
name: rule-creator
description: 帮用户创建一条 Agent 规则（rule）文件，指导 AI 在本项目或全局如何编写代码、遵循什么约定。当用户想"写一条规则""加个 AGENTS 规则""让 AI 以后都按某种方式做"，或提到编码规范、约定、globs 匹配规则时，务必使用本技能。
---

# Rule Creator（创建规则）

帮用户把一条编码约定或 Agent 指令写成规范的规则文件。

## 规则文件格式

规则是带 YAML frontmatter 的 Markdown 文件：

```markdown
---
description: 规则用途的一句话描述
globs: src/**/*.tsx
alwaysApply: false
---

# 规则标题

规则正文，用清晰的祈使句写明约定。解释"为什么"，而不只是"做什么"。
```

字段说明：
- `description`：规则用途，供索引与触发判断。
- `globs`：该规则适用的文件匹配模式（可留空表示不限定）。
- `alwaysApply`：`true` 表示始终注入；`false` 表示按 globs/相关性注入。

## 工作流程

### 1. 明确规则意图
问清楚：
1. 这条规则要约束什么？（编码风格、架构约定、命名、禁止事项……）
2. 适用于哪些文件？（用于填 `globs`）
3. 是否需要始终生效？（用于填 `alwaysApply`）

如果当前对话里已经能看出用户想沉淀的约定（例如刚纠正过 AI 的某个做法），直接从上下文提炼，并请用户确认。

### 2. 起草规则
根据回答填好 frontmatter 与正文。正文尽量：
- 用祈使句（"使用 X""避免 Y"）。
- 解释背后的原因，让模型能举一反三，而不是堆砌 MUST。
- 给正反例，帮助理解边界。

### 3. 询问落盘位置
写入前**务必询问用户**放到哪里：
- **项目级**：`<项目根>/.codez/rules/<filename>.md`（仅本项目）
- **全局**：`~/.codez/rules/<filename>.md`（所有项目）

如果当前没有打开项目，只能选全局。并与用户确认文件名（kebab-case，`.md` 结尾）。

### 4. 写入并确认
写入文件后，告诉用户文件路径，以及规则会在后续会话中如何生效。
```

- [ ] **Step 5: 校验三个目录结构**

Run: `find resources/builtin-skills -name SKILL.md | sort`
Expected:
```
resources/builtin-skills/find-skills/SKILL.md
resources/builtin-skills/rule-creator/SKILL.md
resources/builtin-skills/skill-creator/SKILL.md
```

- [ ] **Step 6: Commit**

```bash
git add resources/builtin-skills
git commit -m "feat(skill): bundle builtin skill resources (skill-creator, find-skills, rule-creator)"
```

---

## Task 5: 首启同步内置技能（syncBuiltinSkills）

**Files:**
- Modify: `src/main/services/SkillManager.ts:114-134`（替换 `initializeGlobalSkillsIfNeeded`）
- Modify: `src/main/services/SkillManager.ts:136-157`（`scanWorkspace` 调用点）
- Modify: `src/main/services/SkillManager.ts:1-10`（imports）

**Interfaces:**
- Consumes: `resolveBuiltinSkillsDir`、`BUILTIN_SKILL_NAMES`（Task 2）；类内已有 `copyDirectory` 递归实现（`importSingleExternalSkill` 内的同名局部函数——需提为私有方法复用）。
- Produces: `syncBuiltinSkills(): Promise<void>`，在 `scanWorkspace` 开头调用，替代旧的 `initializeGlobalSkillsIfNeeded`。

- [ ] **Step 1: 补充 import**

在 `src/main/services/SkillManager.ts` 顶部（Task 3 加的 import 之后）加：

```ts
import { BUILTIN_SKILL_NAMES, resolveBuiltinSkillsDir } from './BuiltinSkills'
```

- [ ] **Step 2: 新增私有 copyDirectory 方法**

现有 `importSingleExternalSkill` 与 `importExternalSkills` 内各有一个局部 `copyDirectory` 函数。新增一个类级私有方法以便复用（放在 `deleteSkill` 之后）：

```ts
  /** 递归复制目录（覆盖同名文件）。 */
  private async copyDirectory(src: string, dest: string): Promise<void> {
    if (!fs.existsSync(dest)) {
      await fs.promises.mkdir(dest, { recursive: true })
    }
    const entries = await fs.promises.readdir(src, { withFileTypes: true })
    for (const entry of entries) {
      const s = path.join(src, entry.name)
      const d = path.join(dest, entry.name)
      let isDir = false
      try {
        isDir = fs.statSync(s).isDirectory()
      } catch (e) {}
      if (isDir) {
        await this.copyDirectory(s, d)
      } else {
        await fs.promises.copyFile(s, d)
      }
    }
  }
```

- [ ] **Step 3: 用 syncBuiltinSkills 替换 initializeGlobalSkillsIfNeeded**

将 `src/main/services/SkillManager.ts` 中整个 `initializeGlobalSkillsIfNeeded` 方法（约 114-134 行，含写死的 Code-Review 逻辑）替换为：

```ts
  /**
   * 将打包的内置技能同步到全局技能目录（覆盖，保证随应用升级更新内容）。
   * 找不到打包资源时静默跳过，不阻断技能扫描。
   */
  private async syncBuiltinSkills(): Promise<void> {
    const srcRoot = resolveBuiltinSkillsDir()
    if (!srcRoot) {
      console.warn('[SkillManager] builtin skills resource dir not found, skip sync')
      return
    }

    const globalDir = this.getGlobalSkillsDir()
    if (!fs.existsSync(globalDir)) {
      await fs.promises.mkdir(globalDir, { recursive: true })
    }

    for (const name of BUILTIN_SKILL_NAMES) {
      const src = path.join(srcRoot, name)
      try {
        if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue
        await this.copyDirectory(src, path.join(globalDir, name))
      } catch (e) {
        console.error(`[SkillManager] failed to sync builtin skill ${name}:`, e)
      }
    }
  }
```

- [ ] **Step 4: 更新 scanWorkspace 调用点**

在 `scanWorkspace` 方法开头，将：

```ts
  public async scanWorkspace(workspaceRoot: string | null): Promise<SkillDefinition[]> {
    await this.initializeGlobalSkillsIfNeeded()
```

改为：

```ts
  public async scanWorkspace(workspaceRoot: string | null): Promise<SkillDefinition[]> {
    await this.syncBuiltinSkills()
```

- [ ] **Step 5: 更新单元测试以覆盖同步**

在 `src/tests/skill-manager-builtin.test.ts` 增加一个用例，验证有打包资源时会复制。追加：

```ts
  it('syncBuiltinSkills 从打包资源复制内置技能到全局目录', async () => {
    // 造一个假的打包资源目录
    const resDir = path.join(home, 'builtin-res')
    const scDir = path.join(resDir, 'skill-creator')
    await fs.mkdir(scDir, { recursive: true })
    await fs.writeFile(
      path.join(scDir, 'SKILL.md'),
      '---\nname: skill-creator\ndescription: official\n---\nbody',
      'utf-8'
    )
    await fs.mkdir(path.join(scDir, 'scripts'), { recursive: true })
    await fs.writeFile(path.join(scDir, 'scripts', 'run.py'), 'print(1)\n', 'utf-8')
    process.env.CODEZ_BUILTIN_SKILLS_DIR = resDir

    ;(SkillManager as any)['instance'] = undefined
    const sm = SkillManager.getInstance()
    const skills = await sm.scanWorkspace(null)

    const creator = skills.find((s) => s.id === 'global-skill-creator')
    expect(creator?.builtin).toBe(true)
    // 子目录脚本也被复制
    const copied = await fs.readFile(
      path.join(home, '.codez', 'skills', 'skill-creator', 'scripts', 'run.py'),
      'utf-8'
    )
    expect(copied).toContain('print(1)')
  })
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run src/tests/skill-manager-builtin.test.ts`
Expected: PASS（三个用例均通过）

- [ ] **Step 7: 类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/services/SkillManager.ts src/tests/skill-manager-builtin.test.ts
git commit -m "feat(skill): sync bundled builtin skills into global dir on scan"
```

---

## Task 6: electron-builder 打包配置

**Files:**
- Modify: `package.json:73-75`（`build.files` 之后加 `extraResources`）

**Interfaces:**
- Consumes: `resources/builtin-skills/`（Task 4）
- Produces: 打包后 `process.resourcesPath/builtin-skills` 存在，供 `resolveBuiltinSkillsDir`（Task 2）命中。

- [ ] **Step 1: 加 extraResources**

在 `package.json` 的 `build` 对象内，把 `files` 段改为同时含 `extraResources`：

```json
    "files": [
      "out/**/*"
    ],
    "extraResources": [
      {
        "from": "resources/builtin-skills",
        "to": "builtin-skills"
      }
    ]
```

- [ ] **Step 2: 校验 JSON 合法**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('ok')"`
Expected: 输出 `ok`

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "build: bundle builtin-skills as extraResources"
```

---

## Task 7: `App` 新增 handleCreateFromSkill 回调并透传

**Files:**
- Modify: `src/renderer/src/App/index.tsx:19-52`（引入 store action、定义回调）
- Modify: `src/renderer/src/App/index.tsx:92-101`（settings 视图渲染处传 prop）

**Interfaces:**
- Consumes: `useChatStore` 的 `createSession(projectId): string`、`setPendingPrompt(prompt): void`（均已存在）；`workspace`（来自 `useAppWorkspace`）。
- Produces: `handleCreateFromSkill(triggerName: string, promptSuffix: string): void`，透传给 `SettingsPage` 的 `onCreateFromSkill` prop（Task 8 消费）。

- [ ] **Step 1: 引入 store actions**

在 `src/renderer/src/App/index.tsx` 顶部组件内已有 `useChatStore` 用法区（约 21-28 行）之后，加入：

```ts
  const createSession = useChatStore((s) => s.createSession)
  const setPendingPrompt = useChatStore((s) => s.setPendingPrompt)
```

- [ ] **Step 2: 定义回调**

在 `const hasMessages = messages.length > 0`（约第 90 行）之后、`if (currentView === 'settings')` 之前，加入：

```ts
  const handleCreateFromSkill = (triggerName: string, promptSuffix: string) => {
    if (workspace) createSession(workspace.id)
    setPendingPrompt(`/${triggerName} ${promptSuffix}`)
    setCurrentView(hasMessages || workspace ? 'chat' : 'home')
  }
```

- [ ] **Step 3: 传给 SettingsPage**

将 settings 视图渲染块（约 92-101 行）改为传入回调：

```tsx
  if (currentView === 'settings') {
    return (
      <div className="settings-view-wrapper">
        <SettingsPage
          initialTab={settingsTab}
          onBack={() => setCurrentView(hasMessages ? 'chat' : 'home')}
          onCreateFromSkill={handleCreateFromSkill}
        />
      </div>
    )
  }
```

- [ ] **Step 4: 类型检查（预期报错 —— SettingsPage 尚无该 prop）**

Run: `npm run typecheck`
Expected: FAIL，报 `SettingsPage` 不接受 `onCreateFromSkill`。Task 8 修复。此处先确认改动本身语法无误（错误只应指向该 prop）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App/index.tsx
git commit -m "feat(ui): add handleCreateFromSkill callback in App"
```

---

## Task 8: SettingsPage 透传 onCreateFromSkill

**Files:**
- Modify: `src/renderer/src/pages/SettingsPage.tsx:15-18`（Props 接口）
- Modify: `src/renderer/src/pages/SettingsPage.tsx:31`（解构 props）
- Modify: `src/renderer/src/pages/SettingsPage.tsx:183-193`（Skills/Rules Tab 渲染）

**Interfaces:**
- Consumes: `onCreateFromSkill(triggerName, promptSuffix)`（Task 7）
- Produces: 透传给 `SettingsSkillsTab`（`onCreate`）与 `SettingsRulesTab`（`onCreate`），供 Task 9、10 消费。

- [ ] **Step 1: 扩展 Props**

将 `src/renderer/src/pages/SettingsPage.tsx` 的 Props 接口改为：

```ts
interface Props {
  onBack: () => void
  initialTab?: string
  onCreateFromSkill?: (triggerName: string, promptSuffix: string) => void
}
```

- [ ] **Step 2: 解构**

将 `export default function SettingsPage({ onBack, initialTab }: Props)` 改为：

```ts
export default function SettingsPage({ onBack, initialTab, onCreateFromSkill }: Props): React.ReactElement {
```

- [ ] **Step 3: 传给两个 Tab**

将 Skills 与 Rules 的渲染分支改为：

```tsx
    if (activeGlobalMenu === 'skills') {
      return (
        <SettingsSkillsTab
          onCreate={() => onCreateFromSkill?.('skill-creator', '帮我写一个技能：')}
        />
      )
    }

    if (activeGlobalMenu === 'agents') {
      return <SettingsAgentsTab />
    }

    if (activeGlobalMenu === 'rules') {
      return (
        <SettingsRulesTab
          onCreate={() => onCreateFromSkill?.('rule-creator', '帮我写一条规则：')}
        />
      )
    }
```

- [ ] **Step 4: 类型检查（预期报错 —— 两个 Tab 尚无 onCreate prop）**

Run: `npm run typecheck`
Expected: FAIL，报 `SettingsSkillsTab` / `SettingsRulesTab` 不接受 `onCreate`。Task 9、10 修复。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/pages/SettingsPage.tsx
git commit -m "feat(ui): thread onCreateFromSkill through SettingsPage to tabs"
```

---

## Task 9: SettingsSkillsTab —— `+` 改新建技能 + builtin 保护 + 打开文件夹按钮

**Files:**
- Modify: `src/renderer/src/components/SettingsSkillsTab.tsx:11`（组件签名/Props）
- Modify: `src/renderer/src/components/SettingsSkillsTab.tsx:7`（图标 import）
- Modify: `src/renderer/src/components/SettingsSkillsTab.tsx:93-124`（header 按钮组）
- Modify: `src/renderer/src/components/SettingsSkillsTab.tsx:174-195`（列表项操作区）

**Interfaces:**
- Consumes: `onCreate: () => void`（Task 8）
- Produces: 无（末端 UI）

- [ ] **Step 1: 加图标 import**

将 `src/renderer/src/components/SettingsSkillsTab.tsx` 第 7 行的 Icons import 补上 `IconFolderOpen`：

```ts
import { IconAdd, IconDownload, IconRefreshCw, IconPackage, IconSearch, IconTrash, IconFolderOpen } from './Icons'
```

- [ ] **Step 2: 组件接收 onCreate prop**

将组件签名由：

```ts
export default function SettingsSkillsTab(): React.ReactElement {
```

改为：

```ts
interface Props {
  onCreate?: () => void
}

export default function SettingsSkillsTab({ onCreate }: Props): React.ReactElement {
```

- [ ] **Step 3: header 按钮：`+` 改新建技能，新增打开文件夹**

将 header 的按钮组（约 93-124 行 `<div className="skills-action-group">...`）改为：`+` 触发 `onCreate`，另加一个文件夹图标按钮承接原 `handleOpenFolder`：

```tsx
        <div className="skills-action-group">
          <Button
            variant="ghost"
            size="none"
            onClick={() => onCreate?.()}
            title="新建技能（AI 帮你写）"
          >
            <IconAdd className="w-[18px] h-[18px]" />
          </Button>

          <Button
            variant="ghost"
            size="none"
            onClick={handleOpenFolder}
            title="打开本地技能目录"
          >
            <IconFolderOpen className="w-[18px] h-[18px]" />
          </Button>

          <Button
            variant="ghost"
            size="none"
            onClick={() => setShowImportModal(true)}
            title="从 Codex / Claude 选择性导入技能"
            className="relative"
          >
            <IconDownload className="w-[18px] h-[18px]" />
            {externalCheckResult?.hasUpdates && (
              <span className="skills-badge-dot"></span>
            )}
          </Button>

          <Button
            variant="ghost"
            size="none"
            onClick={loadSkills}
          >
            <IconRefreshCw className={`w-[18px] h-[18px] ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
```

- [ ] **Step 4: builtin 列表项隐藏删除按钮 + 系统徽标**

将列表项操作区（约 174-195 行 `<div className="skills-item-actions">...`）改为：内置技能类型标签显示"系统"，且不渲染删除按钮：

```tsx
                <div className="skills-item-actions">
                  <span className="skills-item-type">
                    {skill.builtin ? '系统' : skill.isGlobal ? '个人' : '项目'}
                  </span>
                  <label className="skills-switch-label">
                    <input
                      type="checkbox"
                      className="skills-switch-input"
                      checked={!!skill.enabled}
                      onChange={(e) => handleToggle(skill.id, e.target.checked)}
                    />
                    <div className="skills-switch-inner"></div>
                  </label>
                  {!skill.builtin && (
                    <button
                      className="skills-item-delete"
                      title="删除技能"
                      disabled={deletingId === skill.id}
                      onClick={() => handleDelete(skill)}
                    >
                      <IconTrash className="w-4 h-4" />
                    </button>
                  )}
                </div>
```

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: Skills 相关报错消失（Rules 的 `onCreate` 报错仍在，Task 10 修复）。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/SettingsSkillsTab.tsx
git commit -m "feat(ui): skills + button creates skill via chat; protect builtin skills"
```

---

## Task 10: SettingsRulesTab —— 新增"AI 帮写规则"入口

**Files:**
- Modify: `src/renderer/src/components/SettingsRulesTab/index.tsx:12`（组件签名/Props）
- Modify: `src/renderer/src/components/SettingsRulesTab/index.tsx:1-10`（图标 import，如需）
- Modify: `src/renderer/src/components/SettingsRulesTab/index.tsx:172-195`（全局规则 header 区）

**Interfaces:**
- Consumes: `onCreate: () => void`（Task 8）
- Produces: 无（末端 UI）

- [ ] **Step 1: 组件接收 onCreate prop**

将 `src/renderer/src/components/SettingsRulesTab/index.tsx` 的组件签名由：

```ts
export default function SettingsRulesTab(): React.ReactElement {
```

改为：

```ts
interface Props {
  onCreate?: () => void
}

export default function SettingsRulesTab({ onCreate }: Props): React.ReactElement {
```

- [ ] **Step 2: 加图标 import**

确认第 4 行 import 含 `IconZap`（用作"AI 帮写"图标）；若无则从 `../Icons` 引入。将第 4 行改为：

```ts
import { IconFolder, IconChevron, IconMessagePlus, IconMessage, IconTrash, IconZap } from '../Icons'
```

（`IconZap` 已在 Icons.tsx 导出，见 SettingsPage 的 import。）

- [ ] **Step 3: 在规则设置头部加"AI 帮写规则"按钮**

在 `src/renderer/src/components/SettingsRulesTab/index.tsx` 的 `settings-provider-header` 块（约 173-176 行）内，描述段之后加入一个按钮：

```tsx
        <div className="settings-provider-header">
          <h1 className="settings-provider-title">规则设置</h1>
          <p className="settings-provider-desc">管理全局和项目的 Agent 规则，指导 AI 如何编写代码。</p>
          <button
            className="project-action-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8 }}
            onClick={() => onCreate?.()}
            title="让 AI 帮你写一条规则"
          >
            <IconZap />
            <span>AI 帮写规则</span>
          </button>
        </div>
```

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: PASS（所有 `onCreate` 报错消失）

- [ ] **Step 5: 运行全部测试**

Run: `npx vitest run`
Expected: PASS（含 Task 3/5 新增用例；无回归）

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/SettingsRulesTab/index.tsx
git commit -m "feat(ui): add AI-assisted rule creation entry via /rule-creator"
```

---

## Task 11: 端到端手动验证

**Files:** 无（验证任务）

**Interfaces:**
- Consumes: 前述全部任务
- Produces: 验证结论

- [ ] **Step 1: 构建与类型检查**

Run: `npm run typecheck && npm run build`
Expected: 均成功。

- [ ] **Step 2: 内置技能首启同步**

删除本地全局技能目录后启动 dev：

```bash
rm -rf ~/.codez/skills
npm run dev
```

在设置→技能页确认出现 `skill-creator`、`find-skills`、`rule-creator` 三个技能，类型标签显示"系统"。确认 `~/.codez/skills/skill-creator/` 下带有官方子目录（scripts/ 等）。

- [ ] **Step 3: 删除保护**

在技能页确认三个内置技能**无删除按钮**；对普通技能仍有删除按钮。

- [ ] **Step 4: 启停**

切换某个内置技能的开关，在聊天输入 `/` 确认停用后不再出现在候选、启用后出现。

- [ ] **Step 5: Skills `+` 跳转预填**

技能页点 `+`，确认跳到聊天视图、输入框预填 `/skill-creator 帮我写一个技能：`（精确小写），且 `/skill-creator` 命中斜杠菜单。

- [ ] **Step 6: Rules "AI 帮写规则" 跳转预填**

规则页点"AI 帮写规则"，确认预填 `/rule-creator 帮我写一条规则：`。

- [ ] **Step 7: 无工作区边界**

不打开任何项目，点 Skills `+`，确认不报错、预填生效（切到 home 视图）。

- [ ] **Step 8: 打开文件夹按钮**

技能页点文件夹图标，确认打开本地 `.skills` 目录（有工作区时）。

---

## Self-Review Notes

- **Spec 覆盖**：内置技能来源/打包（Task 4、6）、builtin 字段（Task 1）、标记+删除保护（Task 3）、首启覆盖同步（Task 5）、`+` 跳转预填（Task 7-10）、无工作区边界（Task 7 逻辑 + Task 11 Step 7）、大小写（Global Constraints + Task 4 Step 2）、find-skills 询问安装位置 / rule-creator 询问落盘（Task 4 正文）均有对应任务。
- **类型一致性**：`onCreateFromSkill(triggerName, promptSuffix)`（App/SettingsPage）与 Tab 侧的 `onCreate: () => void` 通过 SettingsPage 内联箭头适配，签名一致；`resolveBuiltinSkillsDir`、`BUILTIN_SKILL_NAMES`、`isBuiltinSkillName`、`copyDirectory` 在定义与使用处名称一致。
- **占位符**：无 TODO/TBD；每个代码步骤含完整代码。
- **已知刻意的中间态失败**：Task 7 Step 4、Task 8 Step 4 的 typecheck FAIL 是预期的跨任务顺序产物，在 Task 8/9/10 修复。
