# Claude Code `Glob`

来源：`src/tools/GlobTool/prompt.ts`、`GlobTool.ts`。

## 输入契约

```json
{
  "pattern": "src/**/*.ts",
  "path": "/absolute/search/root"
}
```

`pattern` 必填，`path` 可选。path 必须是存在且可读的目录；省略时使用当前工作目录。

## 核心算法

```text
解析和验证 root
-> 执行 glob
-> 读取匹配项 mtime
-> 按修改时间排序
-> 默认截取 100 项
-> cwd 内路径转成相对路径，外部路径保持绝对
-> 返回结果和截断提示
```

相对化是 token 优化，不改变实际访问边界。按 mtime 排序能把近期文件放前面，但它不等于相关性排序，生成文件或批量 checkout 可能把真正入口挤出前 100 项。

## 使用边界

Glob 适合已知文件名/扩展名模式。内容搜索用 Grep，已知路径用 Read；开放式多轮调查才考虑 Explore。主 Agent 不应因为“可能需要两个 glob”就自动创建子智能体。
