# Agent Coding Desktop 需求文档总入口

> 项目名称：MyAgent / Agent Coding Desktop  
> 技术方向：Electron + TypeScript + React  
> 文档类型：模块化需求分析索引  
> 创建日期：2026-06-25  
> 说明：原单文件需求文档已拆分到 `docs/requirements/` 目录，便于后续分模块设计、开发、测试和验收。

---

## 1. 推荐阅读顺序

1. [产品概述](./requirements/01-product-overview.md)
2. [技术选型](./requirements/02-technical-stack.md)
3. [核心概念](./requirements/03-core-concepts.md)
4. [Workspace 与项目管理](./requirements/04-workspace-project.md)
5. [模型 Provider 与 API 接入](./requirements/05-model-provider.md)
6. [Agent Runtime 与任务执行](./requirements/06-agent-runtime.md)
7. [工具调用系统](./requirements/07-tool-system.md)
8. [上下文管理与项目记忆](./requirements/08-context-memory.md)
9. [代码修改与 Diff 审查](./requirements/09-code-change-diff.md)
10. [命令执行、测试验证与修复循环](./requirements/10-command-verification.md)
11. [UI/UX 需求](./requirements/11-ui-ux.md)
12. [非功能需求](./requirements/12-non-functional.md)
13. [系统架构与数据存储](./requirements/13-architecture-storage.md)
14. [权限、安全与隐私策略](./requirements/14-security-privacy.md)
15. [分阶段开发计划与验收](./requirements/15-development-phases.md)
16. [关键数据结构](./requirements/16-data-structures.md)
17. [风险、总验收与后续路线](./requirements/17-risks-acceptance-roadmap.md)
18. [Skills 与 MCP 最终扩展](./requirements/18-skills-mcp-integration.md)

---

## 2. 模块文件说明

| 文件 | 作用 |
|---|---|
| `01-product-overview.md` | 说明项目目标、背景、用户、边界和 MVP 范围 |
| `02-technical-stack.md` | 说明 Electron、TypeScript、React、模型 API、测试等技术选型 |
| `03-core-concepts.md` | 定义 Workspace、Session、Task、Tool、Permission、Diff 等核心概念 |
| `04-workspace-project.md` | 说明打开项目、文件树、项目识别、最近项目等需求 |
| `05-model-provider.md` | 说明多模型厂商接入、配置、安全存储、模型选择等需求 |
| `06-agent-runtime.md` | 说明 Agent Loop、任务模式、计划、中断继续等需求 |
| `07-tool-system.md` | 说明文件、搜索、命令、Git 等工具能力 |
| `08-context-memory.md` | 说明项目摘要、上下文选择、token 预算、项目记忆 |
| `09-code-change-diff.md` | 说明代码变更、diff 预览、应用变更和冲突检查 |
| `10-command-verification.md` | 说明命令执行、测试识别、验证和修复循环 |
| `11-ui-ux.md` | 说明主界面布局、页面模块和交互原则 |
| `12-non-functional.md` | 说明性能、稳定性、兼容性等非功能需求 |
| `13-architecture-storage.md` | 说明整体架构、IPC、Agent 模块和本地存储 |
| `14-security-privacy.md` | 说明权限分级、Workspace 边界、敏感文件和隐私策略 |
| `15-development-phases.md` | 说明 0-9 阶段开发计划、测试命令和验收标准 |
| `16-data-structures.md` | 给出关键 TypeScript 数据结构建议 |
| `17-risks-acceptance-roadmap.md` | 说明项目风险、总体验收标准和后续增强方向 |
| `18-skills-mcp-integration.md` | 说明 Skills 与 MCP 作为最后阶段扩展能力的需求 |

---

## 3. 后续维护约定

- 新需求优先新增或修改对应模块文件，不建议重新写成一个超长单文件。
- 阶段计划和验收标准集中维护在 `15-development-phases.md`。
- 架构变更集中维护在 `13-architecture-storage.md`。
- 安全策略集中维护在 `14-security-privacy.md`。
- 具体实现开始后，可继续新增：
  - `docs/architecture/`
    - [01-skills-system.md](./architecture/01-skills-system.md) (阶段9A Skills 架构设计)
    - [02-skills-ui-design.md](./architecture/02-skills-ui-design.md) (阶段9A Skills UI/UX 交互设计)
  - `docs/api/`
  - `docs/testing/`
  - `docs/user-guide/`
