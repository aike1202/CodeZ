# 📋 需求文档 - Skills 系统 (阶段 9A)

> 迭代：iteration-3
> 创建时间：2026-06-27 17:41
> 最后更新：2026-06-27 17:41
> 存放位置：.continue/current/Skills系统-requirements.md

## 需求概述

**一句话描述**：实现可扩展的 Skills 技能流系统，让 Agent 能够根据用户输入自动加载并应用特定场景的专业工作流（如 Code Review、UI 优化等）。

**业务背景**：随着项目能力的不断增加，如果所有的系统提示词和专业领域知识都堆砌在全局提示词中，会导致上下文爆炸、LLM 容易分心以及 token 浪费。我们需要一套插件化机制，通过 `.skills/` 目录挂载特定场景的 Prompt 模板和工具权限配置。

**预期价值**：
1. **隔离上下文**：针对不同任务提供定制化、极简的 System Prompt。
2. **能力扩展**：开发者可以像写 Markdown 一样轻易扩充 Agent 的能力，不需要修改核心的 `AgentRunner` 逻辑。
3. **权限收拢**：在执行如 `Code Review` 这类只读技能时，可以严格限制它不具备 `write_file` 权限。

## 功能需求

### 核心功能（必须实现）

- [ ] **F1**: **Skill 元数据解析与管理**
  - 输入：工作区 `.skills/` 目录下的 `SKILL.md` 文件。
  - 处理：支持扫描目录，读取并解析 `SKILL.md` 中的 YAML Frontmatter（包含 `name`, `description`, `triggers` 等字段）以及正文的 Prompt 模板。
  - 输出：在主进程维护一张可供查询的可用 Skills 列表。

- [ ] **F2**: **Skill 匹配与注入机制**
  - 输入：用户的任务请求文本（如 "review 刚才的代码"）以及已启用的 Skills。
  - 处理：在进入 `AgentRunner` 前，系统能通过自然语言匹配或用户显式触发锁定目标 Skill。
  - 输出：提取目标 Skill 的 markdown 正文，作为额外的 `System Prompt` 附加到本次会话上下文中。

- [ ] **F3**: **前端设置/管理 UI**
  - 输入：主进程返回的已发现 Skills 列表数据。
  - 处理：在现有界面（例如新建一个独立的 Skills 管理面板或融入 Settings 中）展示每个 Skill 的名称、描述及启用开关。
  - 输出：用户可直观地开启、关闭特定的工作流，并且设置能够持久化。

- [ ] **F4**: **基础 API 桥接**
  - 输入：渲染进程请求。
  - 处理：新增 `skill.handlers.ts`，暴露 IPC 接口如 `api.skill.getSkills()`, `api.skill.enableSkill()`, `api.skill.disableSkill()` 等。
  - 输出：供前端直接调用的完整 TypeScript 类型接口。

### 扩展功能（可选实现）

- [ ] **E1**: **工具权限声明与拦截**
  - 支持在 `SKILL.md` 的 YAML 头中定义 `permissions`（如只允许 `read_file`）。
  - 在 `AgentRunner` 或 `ToolManager` 层面进行拦截：如果启用了该 Skill，则隐式禁用超出白名单的危险工具。

## 非功能需求

### 性能要求
- 扫描解析 `.skills/` 目录耗时 < 100ms，且应当在应用启动时或者目录变动时缓存，不在每次对话时重新解析磁盘。

### 兼容性要求
- `SKILL.md` 格式需要兼容普通 Markdown，即前端和系统其它编辑器可以正常查看，不会因为复杂的解析逻辑崩溃。

### 安全要求
- 用户配置和第三方 Skill 不能逃逸出指定的 `.skills/` 目录。
- 保证正则表达式或 yaml 解析不会引发严重的性能阻塞或拒绝服务（DoS）漏洞。

## 约束条件

### 技术栈限制
- **解析库**：需要使用轻量级的 frontmatter 解析方案，可以直接使用正则表达式提取 `---` 包裹的内容，避免引入过重依赖。
- **状态管理**：前端使用目前的 Zustand 进行 Skill 状态维护。

### 其他约束
- 该模块应作为扩展系统（Extension Layer）独立于核心流程之外。如果禁用了所有 Skill，原有的 Agent Coding Loop 必须仍然完美运行。

## 验收标准

### 功能验收
- [ ] **AC1**: 创建一个测试用的 `.skills/test-skill/SKILL.md` 后，重启应用能在 UI 面板看到该技能并可启用。
- [ ] **AC2**: 启用该技能并输入匹配词后，抓取后端日志确认 `AgentRunner` 收到了来自于该 `SKILL.md` 内文的附加 Prompt。
- [ ] **AC3**: 禁用该技能后，再次输入相同的提示，附加 Prompt 不再被注入。

### 质量验收
- [ ] **Q1**: `src/shared/types/skill.ts` 定义严密，没有任何 `any` 类型泄露。
- [ ] **Q2**: 保证 `ToolManager` 原有测试通过且架构不受影响。

## 相关资源

### 示例代码
```typescript
// 预期的解析输出结构
export interface SkillDefinition {
  id: string; // e.g. "code-review"
  name: string;
  description: string;
  triggers: string[];
  content: string; // The markdown body to inject
  enabled: boolean;
}
```
