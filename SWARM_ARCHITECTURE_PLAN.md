# MyAgent 架构进化蓝图：多并发智能体引擎 (Swarm Architecture)

## 🎯 核心愿景
当前业界（包含当前版本的 MyAgent）大多采用“单体循环 (Monolithic Sequential Loop)”架构，即：接受任务 -> 思考 -> 调用工具 -> 结果 -> 继续循环。
为了在执行效率和项目开发速度上超越现有的 AI 开发工具集合（如 Cursor、Cline、Devin 等），MyAgent 将进化为**多并发任务调度中心**，支持同时运行 5～10 个基于细分角色的 Agent，极大缩短需求落地到代码测试完成的时间。

## 🛠️ 改造路线图 (Roadmap)

### 阶段一：打破“全能神”模式，引入角色定义 (Agent Roles & Object Scoping)
* **当前状态**：`AgentRunner` 是大一统的，并且可以调用 `ToolManager` 里的所有 12 个工具。
* **开发计划**：
  1. 引入 `RoleConfig`：根据指派的任务给予不同的系统预设提示词（System Prompt）。
  2. 限制工具权限：例如 **架构师（Manager）** 只能用分析/搜索工具；**底层码农（Coder）** 专注读写特定范围的文件；**测试员（QA）** 专注运行 `RunCommand` 获取报错。

### 阶段二：构建“调度中心与任务总线” (Swarm Dispatcher & IPC Bus)
* **当前状态**：`while (loopCount < 30)` 单线程阻塞逻辑。
* **开发计划**：
  1. 新增 `SwarmDispatcher.ts`。提供一种 `delegate_task(role, sub_prompt, files)` 的核心机制。
  2. 收到复杂任务时，Manager Agent 解析并生成任务依赖图 (DAG)，然后通过 `Promise.all` 等机制并发实例化多个独立的 `AgentRunner` 环境。
  3. 建立内部的消息总线（Message Bus），让独立运行的 Agent 可以互相发送同步信号（例如发消息说“我的模块写完了，API 是 XXX”）。

### 阶段三：攻克并发危机 —— 契约驱动与物理隔离 (Contract-first & Scoping)
为了从根本上避免因为瞎猜变量名或互相覆盖代码造成的冲突，引入“契约优先”的工程管理：
1. **Human-in-the-loop (蓝图确认)**：主脑 Agent 先生成 JSON/Markdown 技术蓝图和数据表结构，在 UI 层向用户请求确认或修改。
2. **契约落地**：一旦确认，主脑必定先写入“前置契约文件”（如 `types/LoginContract.ts`）。
3. **物理隔离分配**：基于契约，调度中心严格划分工作区。前端 Agent 只准写 `src/views/`，后端 Agent 只准写 `server/`。从源头上将代码冲突率降到趋近于 0。

### 阶段四：突破瓶颈：黑板模式与“心灵感应”内存 (The Shared Blackboard)
目前 AI Agent 之间缺乏低延迟的上下文同步，常常需要重新读取整个文件系统。
* **开发计划**：
  1. 在 MyAgent 主进程 `Node.js` 内开辟一块所有并发 Agent 共用的**高速缓存区（Agent Blackboard）**。
  2. 提供两个独占工具：`write_telepathic_memory` 和 `read_telepathic_memory`。
  3. **运作机制**：当后端 Agent 临时加了鉴权字段 `x-auth-token`，它不需要改动文件，直接调用 `write_telepathic_memory` 广播。
  4. 底层 `ContextManager` 会在其他 Agent（比如前端 Agent）每次调用自己的工具之前，将“黑板”里相关的最新情报**强行注入**到其上下文中。这让各个 Agent 拥有了类似“蜂巢意识（Hive Mind）”的默契，彻底解决由于信息差导致的反复调试试错。

### 阶段五：UI 呈现的多轨可视化 (Multi-track Agent UI)
* **开发计划**：
  1. 渲染进程引入树状视图（Tree View / 泳道图）。
  2. 用户看到的是类似“史波克展开树”的形式，左边是主管在思考规划，右侧刷刷刷跳出 5 条子任务进度条，显示不同 Agent 正在疯狂调用读写和测试功能。
  3. 提供微干预机制（Micro-intervention）：用户随时可以在某个子轨点击“暂停”，纠正它的方向，然后它并入主线继续跑。

## 💡 后续开发建议
随时可以从本蓝图的任意一点开启重构。建议的切入点：
1. 先在 `src/main/agent/` 下创建一个原型 `MemoryBlackboard.ts` 并在其中实现内存读写接口。
2. 改造 `AgentRunner.ts`，使其能够在每次系统循环 `loopCount` 增加前，主动检查并拉取 Blackboard 的最新信息。