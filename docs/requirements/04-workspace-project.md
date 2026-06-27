# 04. Workspace 与项目管理

> 模块：打开项目、文件树展示、项目识别、最近项目、文件预览

---

## 1. 打开本地项目

### 功能编号

F1

### 需求描述

用户可以通过桌面应用选择一个本地目录作为 Workspace。

### 输入

- 用户选择的本地目录路径。

### 处理

- 校验目录存在；
- 校验目录可读；
- 建立 Workspace 对象；
- 扫描文件树；
- 识别项目类型；
- 保存最近打开记录。

### 输出

- 进入项目工作区界面；
- 左侧显示项目文件树；
- 顶部显示当前项目名称。

### 功能要求

- 支持通过文件选择器打开目录；
- 支持显示最近打开项目；
- 支持重新打开上次项目；
- 支持读取 `.gitignore` 并忽略不必要文件；
- 默认排除：`node_modules`、`.git`、`dist`、`build`、`.next`、`coverage` 等目录。

---

## 2. 项目类型识别

### 功能编号

F2

### 支持类型

系统需要识别：

- Node.js / TypeScript 项目；
- React / Vite 项目；
- Next.js 项目；
- Python 项目；
- Java / Maven / Gradle 项目；
- Rust / Cargo 项目；
- Go 项目；
- 未知项目。

### 识别依据

| 项目类型 | 识别文件 |
|---|---|
| Node.js | `package.json` |
| TypeScript | `tsconfig.json` |
| Vite | `vite.config.*` |
| Next.js | `next.config.*` |
| Python | `pyproject.toml`、`requirements.txt` |
| Maven | `pom.xml` |
| Gradle | `build.gradle`、`build.gradle.kts` |
| Rust | `Cargo.toml` |
| Go | `go.mod` |

### 输出内容

项目识别结果应至少包含：

- projectType；
- packageManager，可选；
- framework，可选；
- testCommandCandidates；
- buildCommandCandidates。

---

## 3. 文件树展示

### 功能编号

F3

### 输入

- Workspace 根目录。

### 处理

- 扫描文件树；
- 过滤忽略文件；
- 区分文件和目录；
- 记录文件大小、扩展名和是否可预览。

### 输出

- 左侧文件树 UI。

### 功能要求

- 支持展开/折叠目录；
- 支持点击打开文件；
- 支持搜索文件名；
- 支持显示文件图标；
- 支持高亮被 Agent 修改的文件；
- 支持刷新文件树；
- 支持处理目录过大时的懒加载或数量限制。

---

## 4. 文件预览

### 支持能力

- 点击文本文件显示内容；
- 大文件超过阈值时提示并只读取前 N 行；
- 二进制文件不直接预览；
- 敏感文件默认不预览，除非用户确认；
- 文件内容展示应保留行号。

### 默认大文件策略

- 超过 1 MB：提示大文件；
- 超过 5 MB：默认拒绝完整读取；
- 超过 10 MB：只允许用户手动确认后分片读取。

---

## 5. 最近项目

系统需要记录最近打开过的项目，字段包括：

- workspaceId；
- rootPath；
- name；
- projectType；
- lastOpenedAt。

### 验收标准

- 应用重启后仍能看到最近项目；
- 点击最近项目可以重新打开；
- 如果路径不存在，应提示用户移除记录或重新选择。
