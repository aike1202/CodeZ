# 18. Skills 与 MCP 最终扩展

> 模块：Skills 系统、MCP 工具扩展、与 Agent Runtime / Tool Manager / Permission Manager 的关系  
> 阶段定位：最后阶段扩展能力，放在核心 Agent Coding 流程和打包发布之后实现

---

## 1. 定位说明

Skills 与 MCP 不作为第一版核心链路的前置能力，而是放在最后阶段实现。

原因：

- Skills 和 MCP 都依赖稳定的 Agent Runtime；
- MCP 需要复用 Tool Manager、Permission Manager、日志系统和命令执行能力；
- Skills 需要复用任务识别、Prompt 注入、上下文管理和工具权限系统；
- 如果过早接入，会增加项目复杂度，影响核心 Agent Coding 流程落地；
- 对学校项目而言，先完成“打开项目 → 聊天 → 读文件 → 改代码 → diff → 运行测试”的闭环更重要。

因此最终阶段顺序确定为：

```text
阶段 0：项目初始化与基础工程
阶段 1：项目打开、文件树与 Workspace 管理
阶段 2：模型 Provider 配置与基础聊天
阶段 3：基础 Agent Loop 与只读工具调用
阶段 4：任务计划与权限确认
阶段 5：代码修改、diff 预览与应用变更
阶段 6：命令执行、测试验证与修复循环
阶段 7：项目记忆、会话恢复与任务历史
阶段 8：体验优化、打包发布与跨平台准备
阶段 9：Skills 与 MCP 最终扩展
```

---

## 2. Skills 与 MCP 的区别

| 能力 | 定位 | 主要作用 |
|---|---|---|
| Skills | 能力包 / 工作流插件 | 让 Agent 掌握某类任务的专业流程，例如代码审查、前端设计、测试生成 |
| MCP | 外部工具协议 / 工具连接器 | 让 Agent 连接外部系统和工具，例如 GitHub、数据库、浏览器、Figma、文件系统 |

简单理解：

- Skills 解决“Agent 怎么做某类任务”；
- MCP 解决“Agent 能调用哪些外部能力”。

---

## 3. 架构位置

Skills 与 MCP 属于 Agent Runtime 的扩展能力层，同时也需要接入 Tool System。

推荐关系：

```text
Agent Runtime
├── Agent Loop
├── Planner
├── Context Builder
├── Tool Manager
│   ├── Built-in Tools
│   ├── Skill Tools
│   └── MCP Tools
├── Permission Manager
├── Skill Manager      # 最后阶段扩展
└── MCP Manager        # 最后阶段扩展
```

扩展层：

```text
Extension Layer
├── Built-in Skills
├── User Skills
├── MCP Servers
└── External Tool Adapters
```

---

## 4. Skills 系统需求

### 4.1 目标

让 Agent 可以加载本地 Skills，并根据用户任务选择合适 Skill，从而获得特定任务的工作流、提示词、模板和约束。

### 4.2 功能需求

- 支持 Skill 描述文件；
- 支持内置 Skills；
- 支持用户自定义 Skills；
- 支持扫描 Skill 目录；
- 支持启用/禁用 Skill；
- 支持根据用户输入匹配 Skill；
- 支持 Skill Prompt 注入；
- 支持 Skill 声明工具权限；
- 支持 Skill 模板文件；
- 支持 Skill 执行日志；
- 支持 Skill 管理 UI。

### 4.3 Skill 文件结构建议

```text
.skills/
├── code-review/
│   ├── SKILL.md
│   ├── templates/
│   └── examples/
├── frontend-design/
│   ├── SKILL.md
│   ├── templates/
│   └── examples/
└── test-generator/
    ├── SKILL.md
    ├── templates/
    └── examples/
```

### 4.4 Skill 元数据建议

```yaml
name: code-review
title: Code Review
description: Review code changes and provide actionable suggestions.
triggers:
  - review code
  - 代码审查
  - 检查这次修改
permissions:
  - read_file
  - search_text
  - git_diff
```

### 4.5 Skill 执行流程

```text
用户输入任务
↓
Skill Manager 匹配触发条件
↓
找到候选 Skill
↓
向用户或 Agent Runtime 确认使用哪个 Skill
↓
加载 Skill Prompt、模板和权限声明
↓
注入 Agent 上下文
↓
Agent 按 Skill 工作流执行
↓
记录 Skill 执行日志
```

### 4.6 Skills 验收标准

- 应用可以扫描并加载内置 Skills；
- 用户可以启用或禁用 Skill；
- Agent 可以根据用户输入匹配合适 Skill；
- Skill 可以向 Agent 注入工作流提示；
- Skill 所需工具权限可被识别和展示；
- Skill 执行过程有日志记录；
- Skill 不影响未启用时的基础 Agent Coding 流程。

---

## 5. MCP 系统需求

### 5.1 目标

让应用可以配置并连接 MCP Server，把 MCP Server 提供的 tools/resources 注册到 Agent Tool Manager。

### 5.2 功能需求

- MCP Server 配置；
- MCP Client 连接；
- MCP Server 启动/停止；
- MCP Tools 发现；
- MCP Resources 读取，可选；
- MCP Tool 调用；
- MCP 权限确认；
- MCP 调用日志；
- MCP 错误处理；
- MCP Server 重连，可选；
- MCP 管理 UI。

### 5.3 MCP 配置示例

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${secret:github_token}"
      },
      "enabled": true
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceRoot}"],
      "enabled": true
    }
  }
}
```

### 5.4 MCP Tool 注册流程

```text
MCP Server 启动
↓
MCP Client 连接 Server
↓
调用 listTools
↓
将 MCP Tools 转成内部 Tool 定义
↓
注册到 Tool Manager
↓
Agent 可以选择调用
↓
调用前走 Permission Manager
↓
调用后记录 ToolCall 日志
↓
结果返回给 Agent
```

### 5.5 MCP 权限策略

MCP Tool 必须接入统一权限系统。

要求：

- MCP 工具默认不拥有比内置工具更高的权限；
- 访问外部服务前需要明确展示目标；
- 涉及写操作、删除操作、发布操作、远程仓库修改操作必须确认；
- MCP Server 的 env 中敏感字段必须通过 secret 引用；
- MCP 调用日志需要脱敏；
- MCP Server 启动失败不能影响基础应用启动。

### 5.6 MCP 验收标准

- 用户可以配置 MCP Server；
- 应用可以启动和停止 MCP Server；
- 应用可以发现 MCP Tools；
- MCP Tools 可以注册到 Tool Manager；
- MCP Tool 调用前必须经过权限确认；
- MCP 调用结果可以返回 Agent；
- MCP 调用失败时显示清晰错误；
- MCP Server 停止或失败不影响基础 Agent Coding 流程。

---

## 6. 最后阶段可运行测试

```bash
npm run typecheck
npm run test
npm run build
```

建议新增测试：

- Skill 描述文件解析测试；
- Skill 启用/禁用测试；
- Skill 匹配测试；
- Skill Prompt 注入测试；
- MCP 配置解析测试；
- MCP Tool 注册测试；
- MCP Tool 权限拦截测试；
- MCP Server 启动失败错误处理测试。

---

## 7. 最后阶段手动验收

```text
1. 启动应用；
2. 打开 Skills 管理页；
3. 启用一个内置 Skill；
4. 输入能触发该 Skill 的任务；
5. 确认 Agent 能按 Skill 工作流响应；
6. 打开 MCP 管理页；
7. 配置一个测试 MCP Server；
8. 启动并连接 MCP Server；
9. 确认 MCP Tools 出现在工具列表；
10. 触发一次 MCP Tool 调用；
11. 确认调用前有权限确认，调用后有日志；
12. 禁用 Skills/MCP 后，基础 Agent Coding 流程仍可正常使用。
```

---

## 8. 实施建议

最终阶段也可以拆成两个小迭代：

```text
阶段 9A：Skills 系统
阶段 9B：MCP 工具扩展系统
```

如果时间有限，优先级建议：

1. 先实现 Skills，因为更适合学校项目展示“可扩展工作流”；
2. 再实现 MCP，因为 MCP 涉及外部进程、协议连接、工具发现和权限安全，复杂度更高。

如果只做 MVP，可以不实现 Skills/MCP，只需要在架构和文档中预留扩展点。
