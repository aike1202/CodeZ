# Context Manager & Tool Truncation Design

## 1. 目标 (Goal)
彻底解决大模型在工具调用时，因超长输出被 `ContextManager` 暴力截断而导致收到损坏的 JSON 数据，进而引发模型“幻觉”、“死循环重试”的问题。确保大模型在任何边缘情况下都能收到结构完整的 JSON 响应，并获得明确的降级/分页操作指引。

## 2. 核心架构 (Architecture)
采用**三层截断与上下文管理防线 (Three-Layer Context Defense)**：

### 2.1 第一层：工具内部的自主前置截断 (Proactive Tool-Level Truncation)
- **职责**：作为第一道防线，工具内部（如 `ReadFilesTool`, `RunCommandTool`）在产出数据前，基于其特有的参数限制进行截断。
- **机制**：
  - 维持数据结构的合法性（如确保 `files` 数组正常闭合）。
  - 在被截断的具体内容末尾，强制附加 **JIT 错误引导指令 (Just-In-Time Error Prompting)**。
  - **示例**：`[System Note: Content truncated due to length limits. You MUST use startLine and endLine parameters in your next call to paginate.]`
- **优势**：利用 LLM 强大的指令跟随能力，在发生错误的“案发现场”直接告诉它解决方案，避免模型盲目重试。

### 2.2 第二层：中间件智能拦截 (Middleware JSON-Aware Rejection)
- **职责**：作为兜底防线，当工具发生异常或未主动截断，导致输出极其庞大的 JSON 数据时，`ContextManager` 负责安全拦截。
- **机制**：废弃原有的 `string.slice` 暴力切片。改为“尝试解析 JSON”。
  - 如果输出是标准的包装格式 `{ ok: true/false, data: ... }`，则直接将其整体替换为合法的 JSON 错误返回：
    ```json
    {
      "ok": false,
      "error": {
        "code": "SYSTEM_TRUNCATION",
        "message": "[System Note: 工具输出总长度超出了当前上下文安全阈值，已被 ContextManager 完全拦截。请勿重试相同的参数，必须细化参数或使用分页/搜索工具以减小返回体积。]"
      }
    }
    ```
  - 如果非 JSON 格式，则退化为普通切片，但仍会注入强引导语。
- **优势**：保证 LLM 永远不会遇到语法崩溃的半截 JSON，从而维持正常的函数调用闭环。

### 2.3 第三层：动态 Budget 计算 (Dynamic Budget Allocation)
- **职责**：保证拦截阈值的合理性，充分利用长上下文窗口。
- **机制**：废弃 `contextWindowTokens / 100` 的公式。对于 128k 窗口的大模型，单次最大返回允许提升至 `Math.min(60000, Math.floor(contextWindowTokens / 3))`，下限提升至 15000 字符。

## 3. 组件变更设计 (Component Changes)

### 3.1 `src/main/agent/ContextManager.ts`
- 修改 `trimMessages` 中的 `dynamicMaxToolOutput` 计算公式。
- 重写 `truncateToolOutput(content: string, maxChars: number)`：引入 `JSON.parse` 嗅探逻辑。

### 3.2 `src/main/tools/builtin/ReadFilesTool.ts`
- 定位 `maxCharsPerFile` 的截断触发点。
- 修改附加的截断字符串为强系统指令。

### 3.3 `src/main/tools/builtin/RunCommandTool.ts`
- 定位命令行输出超长的截断触发点。
- 修改附加的截断字符串为强系统指令（例如引导其重定向 `> file.txt`）。

## 4. 验证计划 (Verification Plan)
- **单元/类型测试**：运行 `npm run typecheck` 确保 TS 语法正确。
- **集成测试**：
  1. 通过 Prompt 让大模型读取一个 2000 行的大文件（不带 startLine/endLine）。
  2. 观察大模型是否在第一次读取触发截断后，能够听从指令，自动在下一次回复中使用分页参数继续读取，且未出现任何报错或混乱。
