# Grok Build `list_dir`

来源：`crates/codegen/xai-grok-tools/src/implementations/grok_build/list_dir/mod.rs`。

## 输入

```json
{ "target_directory": "." }
```

目标可为 workspace 相对或绝对目录。current contract 区分 not found、permission denied、is a file 和 not a directory；legacy-0.4.10 把这些折叠成历史通用错误。

## 预算常量

- 默认输出预算 10,000 字符。
- 深层 walk 最多 100,000 项。
- depth-1 seed 也独立最多 100,000 项。
- 折叠目录摘要展示前 3 个扩展名桶。

## 核心算法

```text
先独立扫描 depth=1，建立所有顶层 sibling
-> 再对 depth>=2 做受 100k 限制的 ignore::Walk
-> 构造排序后的 DirNode 树和扩展名统计
-> root 先展开
-> 用 BFS 尝试展开各子目录
-> 某个目录展开成本超预算时跳过它，继续尝试后续 sibling
-> 未展开目录显示 subtree 文件数/扩展名摘要
```

先 seed depth-1 是为了避免一个很大的首个目录耗尽全局 walk 配额，导致后面的顶层目录完全不可见。BFS 中对 oversized sibling 使用 `continue`，而不是停止整个算法，也能保留后续小目录。

默认遵守 standard filters 和 `.gitignore`，隐藏 dot files/directories。大目录不会简单截断为前 N 条，而是折叠成例如：

```text
[125 files in subtree: 70 *.rs, 30 *.toml, 10 *.md, ...]
```

这比无结构的路径洪流更适合模型上下文。
