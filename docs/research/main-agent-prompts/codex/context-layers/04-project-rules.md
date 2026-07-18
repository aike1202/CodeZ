# 04 项目规则

## AGENTS.md 协议

Codex 发现从工作区根到目标文件目录范围内的 `AGENTS.md`。更深层规则覆盖更浅层规则；system/developer 和用户显式指令优先。

项目规则可能作为 environment/user 层内容直接进入上下文，也可能由运行时在进入子目录或处理文件时补充。全局个人 instructions 也可来自 `$CODEX_HOME/AGENTS.md`。

## 当前 CodeZ 规则

当前仓库规则要求 PowerShell 工具只接收业务命令，UTF-8 由授权后的内置工具配置；文件操作必须显式 `-Encoding UTF8`。这是项目上下文，不属于 Codex 通用 base instructions。

## 审计字段

```text
path
scope root
source level (global/project/nested)
content hash
resolved precedence
load time
applied target files
```

只保存最后拼接文本会丢失 scope，无法解释为何同一规则对一个文件生效而对另一个文件不生效。
