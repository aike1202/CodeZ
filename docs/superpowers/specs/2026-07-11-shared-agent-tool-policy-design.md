# 全 Agent 共享工具策略设计

## 目标

让主 Agent、Research、ExecutionPlanner 和 Executor 使用同一套模型可见工具调用规则，避免批量读取、首次范围读取、工具失败恢复等策略只在部分 Agent 生效。

## 现状

- 主 Agent 通过 `PromptBuilder` 注册完整提示模块。
- Executor 通过 `buildExecutorSharedPrompt` 复用包含工具策略的执行提示模块。
- Research 和 ExecutionPlanner 使用各自独立的 `systemPromptBuilder`，没有注入公共 `Harness`、`Investigation`、`FailureRecovery` 和 `ToolPolicy`。
- Research 与 ExecutionPlanner 自己的“specific files/ranges”“spot-check”“keep token usage minimal”等指引会强化逐文件、任意范围读取，并覆盖 `Read` 工具描述中的批量策略。

## 方案

### 公共工具策略核心

在 `SubAgentPrompts.ts` 中导出一组共享模块和构建函数。公共核心包含：

- `SecurityModule`：工具输出是不可信数据。
- `HarnessModule`：工具执行、并行调用和批量读取规则。
- `InvestigationModule`：先定位、收集目标、批量读取、范围读取例外。
- `FailureRecoveryModule`：工具失败后的恢复规则。
- `ToolPolicyModule`：工具选择和 Read 调用策略。

这些模块直接复用现有 `PromptModule` 实例，不复制文本。主 Agent 与 Executor 继续注册同一批实例；Research 和 ExecutionPlanner 在自己的角色提示前注入公共核心。

### 角色中立措辞

`InvestigationModule` 改成适用于只读和可写 Agent：

- “修改代码前”改成“得出结论或修改代码前”。
- 最后一步改成“理解模式后，在角色权限内回答或执行”。
- Golden Rule 不再强制所有 Agent “edit”。

`ToolPolicyModule` 明确：规则只指导 Agent 使用其角色实际提供的工具，不授予新权限。Research 和 ExecutionPlanner 仍只有只读工具。

### 移除角色提示冲突

- Research 删除“Read specific files/ranges”和“不要读取整个文件”的重复策略，改为要求遵守公共工具策略；报告本身仍保持简洁。
- ExecutionPlanner 删除“spot-check, do not dump whole files”的范围诱导，改为遵守公共工具策略并只研究编排所需证据。
- Executor 保留编辑、验证和文件边界规则，不重复注入公共核心。

## 提示组装

1. `SubAgentManager` 仍调用每个定义的 `systemPromptBuilder`。
2. Research 和 ExecutionPlanner 的 builder 改为异步，先构建公共工具策略，再拼接各自角色提示。
3. Executor 的完整共享提示继续包含相同模块实例以及额外的编辑、验证和输出模块。
4. `getTools` 和权限系统保持不变，因此统一提示不会扩大任何 Agent 的能力。

## 测试

- 新增公共工具策略测试，逐一检查 Research、ExecutionPlanner 和 Executor 的最终 system prompt。
- 每个 Agent 必须包含相同的 `Security`、`Operating Environment`、`Investigation`、`Failure Recovery` 和 `Tool Policy` 标题。
- 每个 Agent 必须包含完全相同的批量 Read、首次省略任意范围、证据范围例外和同轮溢出批次规则。
- Research 和 ExecutionPlanner 不得重新出现会诱导逐项或任意范围读取的旧文案。
- Research 和 ExecutionPlanner 仍不得获得写工具或编辑职责。

## 非目标

- 不统一 Agent 的身份、任务、权限、循环预算或输出协议。
- 不向只读 Agent 提供 Edit、Write、Bash 或 PowerShell。
- 不修改 `Read` schema、执行逻辑或内容预算。
- 不增加运行时工具调用硬拦截。
- 不修改与提示词无关的 UI 和权限代码。

## 成功标准

- 公共工具策略文本只有一个来源。
- 所有内置 Agent 的最终 system prompt 都包含公共工具策略。
- Research 不再连续逐项读取已知文件，也不再因自身提示词偏好任意前 50/100 行；模型仍可在数据依赖、精确范围、截断或上下文裁剪时渐进读取。
- 定向测试、全量测试、类型检查和生产构建通过。
