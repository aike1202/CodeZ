# Claude Code 请求上下文样例

本目录的两份样例都来自真实 Claude Code `2.1.197` transcript，但属于**重建请求**，不是 HTTP 抓包。

Claude transcript 保存 conversation records，却不保存隐藏 system prompt 与完整 tool schema。为避免伪造，“完整”在这里表示：

- 枚举模型在该轮可见的全部逻辑层。
- 对 transcript 中存在的字段逐字记录或给出原始记录位置。
- 对隐藏层引用源码快照，并标记 `source_reconstructed`。
- 对图片、私有规则和大段 skill 内容做脱敏或内容寻址，不把省略后的样例称为 byte-complete。

## 样例

- `01-real-main-session-reconstructed.md`：主 Agent 首轮收到截图问题并调用 Skill。
- `02-real-explore-subagent-reconstructed.md`：父 Agent 派发一个 Explore 后，子 Agent 的真实首轮上下文和 token 数据。

九层来源、可见性和运行时边界见 [context-layers](../context-layers/README.md)。

## 原始日志敏感性

原始 JSONL 包含截图 base64、绝对路径、项目内容、用户私有 skills/rules 和完整工具结果，因此本仓库只保存脱敏重建，不复制原始 JSONL。
