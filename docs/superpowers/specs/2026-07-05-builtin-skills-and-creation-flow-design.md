# 内置技能与技能/规则创建流程 — 设计文档

- 日期：2026-07-05
- 状态：已确认，待实现
- 关联代码：`SkillManager`、`SettingsSkillsTab`、`SettingsRulesTab`、`App`、`SettingsPage`、`usePromptEditor`

## 1. 背景与目标

当前 CodeZ 已有技能系统：`SkillManager` 扫描全局技能（`~/.codez/skills`）与工作区技能（`<root>/.skills`），支持启停、删除、从 Codex/Claude 导入。但存在几个缺口：

1. 没有随应用分发的**默认内置技能**。
2. 所有技能都可被删除，缺少"系统自带、受保护"的概念。
3. 缺少便捷的"新建技能 / 新建规则"入口——用户需要手写 SKILL.md。

本设计新增三个内置技能，并把技能/规则的创建接入聊天会话：

| 内置技能 | 形态 | 触发名（精确大小写） | 作用 |
|---------|------|-------------------|------|
| **skill-creator** | 官方完整目录树，原样打包 | `/skill-creator` | 引导 AI 帮用户创建/迭代/评测技能 |
| **find-skills** | 轻量单 `SKILL.md`（纯提示词） | `/find-skills` | 引导 AI 用 WebSearch 从网上找现成技能并安装到用户选定目录 |
| **rule-creator** | 轻量单 `SKILL.md`（纯提示词） | `/rule-creator` | 引导 AI 帮用户写一条规则文件 |

## 2. 关键决策（已与用户确认）

1. **内容来源**：三个技能打包进应用随程序分发，首次启动写入 `~/.codez/skills`。
2. **保护机制**：内置技能不可删除，但可启用/停用。
3. **skill-creator 完整度**：原样完整打包 [anthropics/skills 的 skill-creator](https://www.skills.sh/anthropics/skills/skill-creator)（含 `scripts/`、`eval-viewer/`、`agents/`、`references/`、`assets/`）。本地有 Python 环境时，主 Agent 调用技能会执行其中的 `.py` 脚本。
4. **find-skills 机制**：纯提示词驱动，用已有 WebSearch/抓取能力找技能，**每次安装时询问用户**装到项目 `.skills` 还是全局 `~/.codez/skills`。
5. **内置技能作用域**：全局常驻（`~/.codez/skills`）。
6. **命名大小写**：目录名 = 触发名，精确保持（`skill-creator`、`find-skills`、`rule-creator` 全小写）。
7. **升级策略**：应用升级时用打包版本覆盖内置技能内容（skill-creator 递归覆盖整树）；用户的启停开关存在 config，不受覆盖影响。
8. **`+` 按钮**：Skills 页 `+` 改为"新建技能"（跳新会话预填 `/skill-creator`）；Rules 页新增"AI 帮写"入口（`/rule-creator`），与现有内联空白新建共存。
9. **无工作区时**：点 `+` 不强制建会话，只 `setPendingPrompt` + 切视图。

## 3. 架构与数据流

复用现有的 `pendingPrompt` + `createSession` 机制，不新增 IPC，不改单向数据流：

```
点击 + 按钮 (Skills / Rules 页)
  → App.handleCreateFromSkill(triggerName, promptSuffix)
      → 若有 workspace: createSession(workspace.id)
      → setPendingPrompt(`/${triggerName} ${promptSuffix}`)
      → setCurrentView('chat' 或 'home')
  → PromptArea 的 useEffect 消费 pendingPrompt，填入输入框并聚焦（已有逻辑）
```

回调透传链：`App` → `SettingsPage`（新增 prop）→ `SettingsSkillsTab` / `SettingsRulesTab`（新增 prop）。

## 4. 内置技能保护机制

### 4.1 数据模型

`SkillDefinition` 增加字段：

```ts
export interface SkillDefinition {
  // ...现有字段
  builtin?: boolean
}
```

### 4.2 识别

`SkillManager` 维护内置技能名集合：

```ts
private static readonly BUILTIN_SKILL_NAMES = ['skill-creator', 'find-skills', 'rule-creator']
```

`scanDir` 扫到的技能，若其目录名（即 id 去掉 `global-`/`workspace-` 前缀的部分）命中集合，则标 `builtin: true`。仅全局技能可能是内置。

### 4.3 删除保护（双保险）

- **后端**：`deleteSkill` 开头判断，若 `target.builtin === true` 直接返回 `false`。
- **前端**：`SettingsSkillsTab` 对 `builtin` 技能不渲染删除按钮。

### 4.4 启停

`toggleSkill` 不变，内置技能同样走 config 开关。停用后不注入、`/` 列表中被过滤。

## 5. 打包与首次写入 / 升级

### 5.1 打包位置

在仓库新增 `resources/builtin-skills/`：

```
resources/builtin-skills/
├── skill-creator/          # 官方完整目录树
│   ├── SKILL.md
│   ├── scripts/
│   ├── eval-viewer/
│   ├── agents/
│   ├── references/
│   └── assets/
├── find-skills/
│   └── SKILL.md
└── rule-creator/
    └── SKILL.md
```

electron-builder 通过 `extraResources` 把该目录打进安装包（`process.resourcesPath`）。开发模式下从项目内 `resources/builtin-skills/` 读取。用 `app.isPackaged` 区分两种路径。

`package.json` `build` 增加：

```json
"extraResources": [
  { "from": "resources/builtin-skills", "to": "builtin-skills" }
]
```

### 5.2 写入 / 覆盖逻辑

`initializeGlobalSkillsIfNeeded` 改造为 `syncBuiltinSkills`：遍历打包的三个内置技能，逐个**递归复制**到 `~/.codez/skills/<name>/`，直接覆盖（保证升级时内容跟随更新）。复制沿用 `SkillManager` 内已有的 `copyDirectory` 递归实现。

> 权衡：直接覆盖会丢弃用户对内置技能正文的手动修改。因为定位是"系统自带、由应用维护"，采纳覆盖策略。

移除现有 `initializeGlobalSkillsIfNeeded` 里写死的 `Code-Review` 示例技能逻辑（改由内置技能机制统一管理）。

## 6. UI 改动

### 6.1 Skills 页（`SettingsSkillsTab`）

- 顶部 `+` 按钮语义从"打开 `.skills` 文件夹"改为"新建技能"：`onCreate('skill-creator', '帮我写一个技能：')`。
- "打开文件夹"功能移到新增的文件夹图标按钮（header 变为：新建、打开文件夹、导入、刷新）。
- 列表项：`skill.builtin === true` 时不渲染删除按钮，可显示"系统"徽标（复用现有 `个人/项目` 徽标位）。

### 6.2 Rules 页（`SettingsRulesTab`）

- 保留现有每个分组的内联空白新建（`handleNewRule`）。
- 新增"AI 帮写规则"入口：`onCreate('rule-creator', '帮我写一条规则：')`。

### 6.3 跳转回调

`App/index.tsx` 新增：

```ts
const handleCreateFromSkill = (triggerName: string, promptSuffix: string) => {
  if (workspace) createSession(workspace.id)
  setPendingPrompt(`/${triggerName} ${promptSuffix}`)
  setCurrentView(hasMessages || workspace ? 'chat' : 'home')
}
```

透传给 `SettingsPage`（新增 `onCreateFromSkill` prop），再透传给两个 Tab。

## 7. 内置技能正文

- **skill-creator**：使用 anthropics/skills 官方 `skill-creator` 目录树，原样打包，不改写。
- **find-skills**（新写，纯提示词）：引导流程 = 询问需求 → 用 WebSearch 在 GitHub 等处搜索候选技能 → 展示候选并让用户挑选 → **询问装到当前项目 `.skills` 还是全局 `~/.codez/skills`** → 将选定技能的 SKILL.md（及资源）写入目标目录。
- **rule-creator**（新写，纯提示词）：引导流程 = 询问规则用途/globs/alwaysApply → 产出标准 frontmatter + 正文 → 询问落盘位置（全局 `~/.codez/rules` 或项目 `.codez/rules`）→ 写入。

## 8. 改动清单

| 文件 | 改动 |
|------|------|
| `src/shared/types/skill.ts` | `SkillDefinition` 加 `builtin?: boolean` |
| `src/main/services/SkillManager.ts` | 内置名集合；`scanDir` 标 builtin；`deleteSkill` 保护；`initializeGlobalSkillsIfNeeded` → `syncBuiltinSkills`（递归复制打包内置技能，移除 Code-Review 硬编码）；内置技能源路径解析（dev vs packaged） |
| `resources/builtin-skills/skill-creator/**` | 官方目录树原样落地 |
| `resources/builtin-skills/find-skills/SKILL.md` | 新写提示词 |
| `resources/builtin-skills/rule-creator/SKILL.md` | 新写提示词 |
| `package.json` | `build.extraResources` 加 builtin-skills |
| `src/renderer/src/App/index.tsx` | `handleCreateFromSkill`，透传 |
| `src/renderer/src/pages/SettingsPage.tsx` | 新增 `onCreateFromSkill` prop 并透传给两个 Tab |
| `src/renderer/src/components/SettingsSkillsTab.tsx` | `+` 改新建技能；新增打开文件夹按钮；builtin 隐藏删除、显示系统徽标 |
| `src/renderer/src/components/SettingsRulesTab/index.tsx` | 新增"AI 帮写规则"入口（`/rule-creator`） |

## 9. 边界与错误处理

- 无工作区点 `+`：不建会话，只预填 prompt + 切视图。
- 内置技能删除：后端拒绝 + 前端无按钮，双保险。
- 打包资源缺失（`builtin-skills` 目录不存在）：`syncBuiltinSkills` 静默跳过并记日志，不阻断技能扫描。
- 覆盖内置技能：直接覆盖，启停开关（config）保留。

## 10. 测试验证

项目已有 `vitest`。

- **单元测试**（可选，若为 `SkillManager` 补测）：`deleteSkill` 对 builtin 返回 false；`scanDir` 正确标记 builtin。
- **手动验证清单**：
  1. 删除 `~/.codez/skills` 后重启 → 三个内置技能自动出现（skill-creator 带完整子目录）。
  2. 内置技能列表项无删除按钮；后端删除内置返回 false。
  3. 启停内置技能生效，停用后 `/` 列表不出现。
  4. Skills 页 `+` → 新建会话，输入框预填 `/skill-creator 帮我写一个技能：`（精确小写）。
  5. Rules 页"AI 帮写" → 预填 `/rule-creator 帮我写一条规则：`。
  6. 无工作区时点 `+` → 不报错，预填生效。
