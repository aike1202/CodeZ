# Skills 技能流系统 - UI 与交互设计

> 文档编号：ARCH-02
> 模块：Skills 系统 UI/UX 设计
> 更新日期：2026-06-27

## 1. 竞品分析 (Cursor vs Roo Cline)

为了确保 Skills 系统的易用性，我们调研了目前主流的 AI Coding Agent：
- **Cursor**：将自定义行为分为两种。一种是 **Rules (规则)**，存放在 `.cursor/rules/`，它们是“被动”的，全局或特定目录自动生效；另一种是 **Commands (命令)**，通过在输入框输入 `/` 主动唤出并执行特定工作流。
- **Roo Cline / Roo Code**：提供强大的 **Custom Modes (自定义模式)** 下拉菜单（如 Architect, Code, Debug），可以彻底切换 Agent 的人设和可用工具；同时支持 Slash Commands (`/`) 来快速触发特定技能（Skill）。

## 2. 本项目的 UI 交互策略

结合竞品的最佳实践，MyAgent 的 Skills 系统 UI 将从**主动唤起**和**被动管理**两个维度进行设计。

### 2.1 主动唤起：Slash Command 快捷菜单
**场景**：用户希望执行一次性的特定工作流（如 `/code-review`，`/write-test`）。
**UI 设计**：
1. **触发机制**：在底部的 Chat Input (输入框) 键入 `/` 字符时，立刻在其上方弹出一个悬浮菜单 (Popover List)。
2. **菜单内容**：
   - 动态读取 `SkillManager` 提供的技能列表。
   - 列表项左侧显示图标（如 ⚡），中间显示 `skill.name`，下方/右侧显示 `skill.description`。
   - 列表项支持键盘上下键选中和回车确认。
3. **交互结果**：
   - 选中后，输入框内容变为高亮的 Token (Pill 标签，例如 `[⚡ Code Review]`)，或者直接补全为 `/code-review `。
   - 用户继续输入附加说明（如 `/code-review 检查一下刚才的内存泄漏`）并发送。

### 2.2 被动管理：Settings 中的 Skills 面板
**场景**：用户希望定义长期的“规则”（Rules）或开启某个特定的 Agent 模式，每次对话都自动带上这些上下文。
**UI 设计**：
1. **入口**：主界面的“齿轮”设置图标 -> 新增 `Skills (技能)` 选项卡。
2. **布局 (Card Grid / List)**：
   - 顶部提供一个按钮：`📁 打开技能目录 (.skills)`，点击通过系统资源管理器打开对应文件夹，方便用户编写 Markdown。
   - 主体区域渲染技能列表。
3. **卡片设计**：
   - **Header**：大标题为技能名称，右侧为一个 Toggle (开关)。
   - **Body**：技能的详细描述 (`description`)，以及该技能绑定的触发词 (`triggers`) 的 Tag 展示。
4. **状态联动**：开启 Toggle 后，立即写入 `.myagent-cache/skills-config.json`。

### 2.3 状态感知：聊天区状态指示器
**场景**：防止用户忘记开启了哪些全局技能，导致 LLM 上下文爆炸或行为怪异。
**UI 设计**：
- 在聊天对话区域的顶部（或 Input 框的上方），当存在已开启的被动 Skill 时，显示一个微小的状态栏。
- 例如：`🛠️ 已激活技能：Code Review, UI Designer`。
- 点击该状态栏可直接跳转到 Settings -> Skills 面板。

## 3. 前端组件拆解与改造点

1. **`SlashCommandMenu.tsx` (新组件)**
   - 挂载于 `PromptArea.tsx` 内部，监听 `textarea` 的 onChange 事件。
   - 检测到光标前是一个单词且以 `/` 开头时显示。
2. **`SettingsSkillsTab.tsx` (新组件)**
   - 挂载于 `SettingsPanel.tsx`。
   - 使用 `window.api.skill.getAll()` 获取数据，渲染带 Toggle 的卡片。
3. **`ActiveSkillsBadge.tsx` (新组件)**
   - 挂载于 `ChatArea.tsx` 顶部，实时订阅当前激活的技能数量。

## 4. 图标与色彩规范
- **图标**：使用 `lucide-react` 中的 `Zap` (雷电，代表指令)、`Wrench` (扳手，代表规则) 和 `FolderOpen` (打开目录)。
- **色彩**：采用 TailwindCSS 的主题色，被选中的 Slash Command 高亮背景使用 `bg-blue-500/20 text-blue-400` 以凸显特殊身份。
