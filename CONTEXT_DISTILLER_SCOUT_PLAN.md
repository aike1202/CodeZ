# MyAgent 架构进化蓝图：多模态/多级联智能体系统

## 🎯 核心概念：模型套利与侦察兵机制 (Model Arbitrage & Context-Distiller Scout Agent)

在传统 AI 编程助手中，主进程模型往往被迫直接读取大型文件（如 1000 行的 `User.ts`），这会导致：
1. **上下文爆炸与注意力稀释**：主模型的“智商”会在处理长文本中被分心。
2. **极高的 API 成本**：每次操作都需要使用昂贵的顶配模型重新处理冗长的原始代码。
3. **金鱼记忆**：Token 塞满后不得不丢弃早期的关键对话。

为了彻底解决此问题，本系统将从硬核的 AST 语义分析（如 `tree-sitter`）升级为更加灵活、智能且成本极低的 **“廉价大模型提纯机制” (Sub-Agent Distillation)**。

---

## 🕵️‍♂️ 侦察兵智能体 (Scout Agent) 运作机制

系统允许由用户自行配置多种不同等级的 LLM 模型。
* **主脑 Agent (Architect/Coder)**：使用昂贵且逻辑最强的模型（如 Claude 3.5 Sonnet / GPT-4o），专注复杂逻辑重构和任务分发。
* **侦察兵 Agent (Scout)**：使用极其便宜甚至免费的高速模型（如 Gemini 1.5 Flash / LLaMA 3 8B / Qwen），专注“脏活累活”。

### 工作流示例 1：单体精炼提取
1. 主脑调用工具：`ask_scout_agent(files: ["OrderService.ts"], query: "提取公有方法签名并总结状态机逻辑")`
2. 调度中心启动 1 个便宜模型的进程，吞下整个文件并提纯。
3. 主脑获取极度纯净的 50 行摘要，免受几千行代码的干扰。

### 🚀 工作流示例 2：散播-聚集式并发侦察 (Scatter-Gather Swarm Scouting)
当面临跨模块的大型需求（例如：“检查所有的 Utils 文件是否有破坏向后兼容的变化”）时，顺序读取将极其耗尽时间。
1. **并发调用**：主脑发起请求：`ask_scout_agent_batch(files: ["util1.ts", "util2.ts", "util3.ts", ...10个文件], query: "查兼容性漏洞")`
2. **集群爆破**：MyAgent 底层通过 `Promise.all` 瞬间派生出 10 个轻量级的独立侦察兵 Agent，**同时**对 10 个独立文件进行语义扫描与提取。
3. **合并汇报**：数秒钟内，10 份提纯报告同时返回并合并汇总。此时主脑瞬间获得了跨越整个工程的“上帝视角”，耗费的时间只等同于读取 1 个文件的时间！

---

## 🆚 优势对比：为什么不用 AST 解析树？

单纯通过 `tree-sitter` 获取 `Method Signatures` 的局限在于它只是“瞎子摸象”。
* **AST**：只能读出 `login(user, pass) -> void`。
* **Scout Agent**：能读懂注释与人类隐藏约束：`发现 login() 签名，但注意上面的注释说【此方法包含竞态条件，勿轻易调用】，且有 TODO 提示即将迁移到 v2`。

这种 **基于超轻量廉价模型的动态泛化摘要能力** 配合 **高阶主模型的精准执行**，将在性能与智能表现上形成对现有纯执行流工具的降维打击！

## 🛠 开发落足点与待办 (TODO)

1. **Provider 隔离**：在目前的 `ProviderStore` 或 `SessionConfig` 中，允许配置“主模型”和“侦察模型”两组凭证参数。
2. **新增工具集**：在 `ToolManager` 内开发 `AskScoutAgentTool.ts` 和支持并发的 `BatchScoutAgentTool.ts`。
3. **底层并发引擎**：打通 `AgentRunner` 内的异步队列限制，支持启动无状态并行的 `light_agent_call`。