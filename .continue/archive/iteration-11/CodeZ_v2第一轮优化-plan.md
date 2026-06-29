# 📝 开发计划 - CodeZ_v2第一轮优化

> 关联需求：CodeZ_v2第一轮优化-requirements.md
> 迭代：iteration-4
> 全局进度参阅：.continue/index.md

## 整体技术与架构总览
基于现有的 TypeScript Node.js/Electron 架构，通过在 `src/main/` 主进程增强多项 Service 及 Manager 来保障单 Agent 的闭环能力。不引入全新大框架，重构重点为：统一 Tool 体系、增加中间件层 PermissionManager 拦截高危操作、完善编辑事务和状态上下文防丢失结构。

## 阶段与任务大纲

**目标**：完成 CodeZ 单 Agent 的闭环重构，实现“稳定调用-清晰修改-UI审批-自动验证-不怕中断”。

✅ 第一阶段 · 权限隔离与工具系统收敛
  ✅ 1、实现 PermissionManager
     - 结合工程需要实现的详细设计：在 `src/main/services/` 创建 `PermissionManager.ts`。定义 CommandRisk 分类，对工具进行 allow/ask/deny 判断。对于 ask，需通过 IPC 发送 approval request，并挂起进程等待前端回调。
  ✅ 2、收敛 Search 搜索类工具
     - 结合工程需要实现的详细设计：修改/整合现有 search 方案，暴露一个统一的结构化 search 工具，返回包含文件、文本、符号或模糊命中的结构（支持分页及结果数量限制），替代 `ls/find/grep` 等散乱调用。
  ✅ 3、收敛 Read 读取工具
     - 结合工程需要实现的详细设计：整合 `read_files` 并强制加分页/字节数预算限制，返回当前行数/总行数及当前文件摘要 Hash。
  ✅ 4、引入 get_project_snapshot 强化
     - 结合工程需要实现的详细设计：增强此工具，提供当前仓库下所有技术栈、根级文件架构、Scripts 清单、文档目录树等，以便长任务开始前获取蓝图。

✅ 第二阶段 · Patch/Diff 及编辑事务工作流
  ✅ 5、实现 apply_patch 主入口
     - 结合工程需要实现的详细设计：新增写入工具，统一转入 Patch 路径（可极简化最小Patch实现），加入对写入前预期 expectedHashByPath 的强制校验，校验失败立刻提示重新 read。
  ✅ 6、完善结构化 Diff 输出及事务层
     - 结合工程需要实现的详细设计：在 `EditTransactionService` 记录每次写入操作，生成文件级 Diff 给前端渲染，并支持根据 txId 回滚。

🔄 第三阶段 · AgentLoop 与 ProviderAdapter 稳定化
  ✅ 7、Provider 事件一致化与 ToolResult 标准封装
     - 结合工程需要实现的详细设计：在 Provider 适配层将所有停止原因收敛为 `AgentStopReason`。修改 `AgentRunner.ts` 将工具结果封装为 `ToolResult` 包含 ok, data, error。
  ✅ 8、防护循环限流器
     - 结合工程需要实现的详细设计：在 `AgentRunner.ts` 加入连续失败次数上限与 max_loops 限制，防止死循环。

⏳ 第四阶段 · 上下文压缩及状态防丢失机制
  ✅ 9、构建任务状态核心对象
     - 结合工程需要实现的详细设计：在 `ContextManager` 中维护 `GoalSnapshot`, `TaskPlan`, `ResumeState`。Token 超限裁剪时，强制将状态浓缩写入 ResumeState JSON，在下次启动时优先加载。
  ✅ 10、规则拦截注入防护
     - 结合工程需要实现的详细设计：在 Prompt 拼装时限制工具返回物（如文件内容）对系统指令的越权覆盖。

⏳ 第五阶段 · 验证闭环及 UI 整合
  ✅ 11、验证策略分发
     - 结合工程需要实现的详细设计：根据最近改动文件读取 package.json 脚本（如 test/typecheck）推介验证，捕获错误回传模型。
  ✅ 12、丰富 renderer IPC 事件与面板
     - 结合工程需要实现的详细设计：暴露 AgentRunState，推送 ApprovalRequest，提供前端 Accept/Reject 接口。

### 验收&测试点
  ⏳ 1、危险操作拦截：运行覆盖关键文件或 `rm` 操作时，弹出界面卡片审批，不被静默执行。
  ⏳ 2、语法错误自我修复：若写入类型错代码，自动捕获 typecheck 输出，并再次应用 patch 修正。
  ⏳ 3、状态防丟失：中断或长上下文裁剪后，继续运行时能使用 ResumeState 明确自己处于何任务阶段。

## 变更记录
| 时间 | 变更内容 | 调整原因 |
|------|----------|----------|
| 2026-06-28 | 初始化计划 | V2单Agent闭环优化 |
