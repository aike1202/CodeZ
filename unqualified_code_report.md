# 脚本自动分析：项目中有问题的代码与文件列表

本报告由自动化静态代码扫描脚本 `analyze_project.cjs` 生成。脚本排除了 icons、ui 通用库组件，专门扫描了业务 TSX 中直接内联的原生 `<svg>` 以及 className 里耦合的 Tailwind CSS 样式类名。

## 📄 [App.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/App.tsx)

### 🚫 侵入式原生 <svg> 图标 (4 处)
- **行 915**: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">`
- **行 930**: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
- **行 1111**: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">`
- **行 1118**: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">`

### 🚫 耦合的 Tailwind 样式名 (39 处)
- **行 629**: 检测到类名 `text-gray-200`
  代码：`<div className="bg-[#1c1c1c] text-gray-200 h-screen w-full overflow-hidden font-sans">`
- **行 636**: 检测到类名 `text-gray-800`
  代码：`<Flex className="bg-[#fcfcfc] text-gray-800 h-screen w-full overflow-hidden font-sans">`
- **行 655**: 检测到类名 `flex, w-0`
  代码：`<Stack className="flex-1 h-screen relative min-w-0">`
- **行 667**: 检测到类名 `flex`
  代码：`<Flex className="flex-1 overflow-hidden">`
- **行 669**: 检测到类名 `flex`
  代码：`<Stack className={`flex-1 overflow-hidden ${panelOpen ? 'border-r border-gray-200' : ''}`}>`
- **行 670**: 检测到类名 `flex`
  代码：`<Stack ref={containerRef} align="center" className="flex-1 overflow-y-auto w-full">`
- **行 679**: 检测到类名 `flex, p-4`
  代码：`<Stack gap={6} className="w-full max-w-3xl mx-auto flex-1 p-4 pb-0">`
- **行 683**: 检测到类名 `bg-gray-100, text-gray-800, px-4, py-3, rounded-tr, shadow-sm`
  代码：`<div className="bg-gray-100 text-gray-800 px-4 py-3 rounded-2xl rounded-tr-sm max-w-[80%] text-[15px] shadow-sm leading-relaxed">`
- **行 689**: 检测到类名 `w-8, h-8, rounded-full, bg-blue-50, text-blue-600, shadow-sm`
  代码：`<Flex align="center" justify="center" className="w-8 h-8 rounded-full shrink-0 bg-blue-50 text-blue-600 font-bold mr-4 outline outline-2 outline-white shadow-sm text-xs mt-1">`
- **行 692**: 检测到类名 `text-gray-800, py-1, flex, w-0`
  代码：`<div className="text-gray-800 py-1.5 leading-relaxed text-[15px] flex-1 min-w-0">`
- **行 743**: 检测到类名 `my-2`
  代码：`<div className="my-2">`
- **行 880**: 检测到类名 `w-1, bg-blue-500, bg-blue-600`
  代码：`className="w-1 cursor-col-resize hover:bg-blue-500 active:bg-blue-600 transition-colors shrink-0 z-10"`
- **行 910**: 检测到类名 `shadow-xl`
  代码：`className="bg-white overflow-hidden border-l border-gray-200 shadow-xl shrink-0"`
- **行 913**: 检测到类名 `px-4, py-2`
  代码：`<Flex align="center" justify="between" className="px-4 py-2.5 border-b border-gray-200 bg-[#fafbfc] shrink-0">`
- **行 914**: 检测到类名 `text-gray-600, w-0`
  代码：`<Flex align="center" gap={2} className="text-[13px] text-gray-600 min-w-0">`
- **行 919**: 检测到类名 `text-gray-700, text-zinc-300`
  代码：`<span className="truncate font-medium text-gray-700 dark:text-zinc-300">{sideTitle}</span>`
- **行 924**: 检测到类名 `p-1, text-gray-400, text-gray-700`
  代码：`className="p-1 text-gray-400 hover:text-gray-700"`
- **行 933**: 检测到类名 `flex, bg-gray-50, bg-zinc-950`
  代码：`<div className="flex-1 overflow-auto bg-gray-50/20 dark:bg-zinc-950/10">`
- **行 942**: 检测到类名 `flex, items-center, justify-center, text-gray-400`
  代码：`<div className="flex items-center justify-center h-full text-gray-400 text-sm">加载中...</div>`
- **行 991**: 检测到类名 `flex, p-4`
  代码：`<div className="flex flex-col font-mono text-[12px] leading-relaxed p-4 text-left overflow-auto h-full">`
- **行 993**: 检测到类名 `flex, py-0, bg-emerald-500, text-emerald-600, text-emerald-400`
  代码：`<div key={idx} className="flex select-text py-0.5 hover:bg-emerald-500/10 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400">`
- **行 994**: 检测到类名 `w-8, text-gray-400, text-zinc-600`
  代码：`<span className="w-8 shrink-0 text-right pr-2.5 text-gray-400 dark:text-zinc-600 select-none border-r border-emerald-500/20 mr-2">{idx + 1}</span>`
- **行 995**: 检测到类名 `w-4, text-emerald-500`
  代码：`<span className="w-4 shrink-0 text-center select-none text-emerald-500 font-bold">+</span>`
- **行 996**: 检测到类名 `flex`
  代码：`<span className="whitespace-pre-wrap break-all flex-1">{line}</span>`
- **行 1007**: 检测到类名 `flex, p-4`
  代码：`<div className="flex flex-col font-mono text-[12px] leading-relaxed p-4 text-left overflow-auto h-full">`
- **行 1010**: 检测到类名 `flex, py-0, bg-rose-500, text-rose-600, text-rose-400`
  代码：`<div key={`del-${idx}`} className="flex select-text py-0.5 hover:bg-rose-500/10 bg-rose-500/5 text-rose-600 dark:text-rose-400 line-through decoration-rose-500/40">`
- **行 1011**: 检测到类名 `w-8, text-gray-400, text-zinc-600`
  代码：`<span className="w-8 shrink-0 text-right pr-2.5 text-gray-400 dark:text-zinc-600 select-none border-r border-rose-500/20 mr-2">-</span>`
- **行 1012**: 检测到类名 `w-4, text-rose-500`
  代码：`<span className="w-4 shrink-0 text-center select-none text-rose-500 font-bold">-</span>`
- **行 1013**: 检测到类名 `flex`
  代码：`<span className="whitespace-pre-wrap break-all flex-1">{line}</span>`
- **行 1018**: 检测到类名 `flex, py-0, bg-emerald-500, text-emerald-600, text-emerald-400`
  代码：`<div key={`add-${idx}`} className="flex select-text py-0.5 hover:bg-emerald-500/10 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400">`
- **行 1019**: 检测到类名 `w-8, text-gray-400, text-zinc-600`
  代码：`<span className="w-8 shrink-0 text-right pr-2.5 text-gray-400 dark:text-zinc-600 select-none border-r border-emerald-500/20 mr-2">+</span>`
- **行 1020**: 检测到类名 `w-4, text-emerald-500`
  代码：`<span className="w-4 shrink-0 text-center select-none text-emerald-500 font-bold">+</span>`
- **行 1021**: 检测到类名 `flex`
  代码：`<span className="whitespace-pre-wrap break-all flex-1">{line}</span>`
- **行 1091**: 检测到类名 `p-6, bg-zinc-950`
  代码：`<div className="p-6 overflow-auto h-full select-text bg-white dark:bg-zinc-950/10 text-left max-w-none">`
- **行 1098**: 检测到类名 `flex`
  代码：`<div className="flex flex-col h-full overflow-hidden select-text">`
- **行 1100**: 检测到类名 `flex, items-center, justify-between, px-4, py-1, bg-gray-100, bg-zinc-900, text-gray-500, text-zinc-400`
  代码：`<div className="flex items-center justify-between px-4 py-1.5 bg-gray-100/50 dark:bg-zinc-900/50 border-b border-gray-200 dark:border-zinc-800/80 shrink-0 text-[11px] text-gray-500 dark:text-zinc-400 select-none">`
- **行 1107**: 检测到类名 `flex, items-center, text-gray-950, text-zinc-100, text-gray-400`
  代码：`className="flex items-center gap-1 hover:text-gray-950 dark:hover:text-zinc-100 transition-colors text-gray-400"`
- **行 1129**: 检测到类名 `flex, bg-gray-50, bg-zinc-950`
  代码：`<div className="flex-1 overflow-auto bg-gray-50/10 dark:bg-zinc-950/5">`
- **行 1130**: 检测到类名 `p-4, m-0, text-gray-800, text-zinc-200`
  代码：`<pre className="p-4 text-[13px] leading-relaxed font-mono m-0 overflow-auto h-full text-gray-800 dark:text-zinc-200">`

---

## 📄 [components\chat\AgentStateTimeline.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/chat/AgentStateTimeline.tsx)

### 🚫 耦合的 Tailwind 样式名 (14 处)
- **行 9**: 检测到类名 `flex`
  代码：`<div className="flex flex-col gap-2 mb-3">`
- **行 14**: 检测到类名 `text-gray-500, py-2`
  代码：`<div key={state.id} className="text-[13px] text-gray-500 py-2 border-b border-gray-100/60 mb-1 w-full">`
- **行 20**: 检测到类名 `flex, items-center, text-gray-400, py-0`
  代码：`<div key={state.id} className="flex items-center gap-2.5 text-[13px] text-gray-400 py-0.5">`
- **行 21**: 检测到类名 `text-gray-300`
  代码：`<IconLoading className="animate-spin text-gray-300 shrink-0" />`
- **行 27**: 检测到类名 `flex, items-center, text-gray-400, py-0`
  代码：`<div key={state.id} className="flex items-center gap-2.5 text-[13px] text-gray-400 py-0.5">`
- **行 34**: 检测到类名 `flex, items-center, text-gray-500, py-1`
  代码：`<div key={state.id} className="flex items-center gap-2.5 text-[13px] text-gray-500 py-1.5 font-medium mt-1">`
- **行 41**: 检测到类名 `flex, items-center, text-gray-600, bg-gray-50, px-2, py-1`
  代码：`<div key={state.id} className="flex items-center gap-2.5 text-[13px] text-gray-600 bg-gray-50/70 border border-gray-100 rounded px-2.5 py-1.5 w-max">`
- **行 42**: 检测到类名 `text-gray-400`
  代码：`<IconEdit className="text-gray-400" />`
- **行 43**: 检测到类名 `text-gray-500`
  代码：`<span className="font-medium text-gray-500">{state.title}</span>`
- **行 45**: 检测到类名 `flex`
  代码：`<span className="ml-1 flex gap-2 font-mono text-[11.5px]">`
- **行 46**: 检测到类名 `text-green-600`
  代码：`{state.detail.includes('+') && <span className="text-green-600 font-semibold">{state.detail.split(' ')[0]}</span>}`
- **行 47**: 检测到类名 `text-red-500`
  代码：`{state.detail.includes('-') && <span className="text-red-500 font-semibold">{state.detail.split(' ')[1]}</span>}`
- **行 54**: 检测到类名 `flex, items-center, text-gray-500, py-1`
  代码：`<div key={state.id} className="flex items-center gap-2 text-[13px] text-gray-500 py-1.5 mt-2 border-t border-dashed border-gray-200">`
- **行 57**: 检测到类名 `text-gray-400`
  代码：`{state.detail && <span className="text-gray-400 ml-1 text-[12px]">{state.detail}</span>}`

---

## 📄 [components\chat\EditApprovalWidget.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/chat/EditApprovalWidget.tsx)

### 🚫 侵入式原生 <svg> 图标 (2 处)
- **行 163**: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
- **行 172**: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>`

### 🚫 耦合的 Tailwind 样式名 (16 处)
- **行 87**: 检测到类名 `shadow-sm`
  代码：`<Card variant="default" rounded="md" className="mt-4 border border-gray-200 dark:border-zinc-800 bg-white dark:bg-[#1e1e1e] shadow-sm overflow-hidden text-[13px] font-sans">`
- **行 89**: 检测到类名 `px-3, py-2, bg-gray-50`
  代码：`<Flex align="center" justify="between" className="px-3 py-2 bg-gray-50 dark:bg-[#252526] border-b border-gray-200 dark:border-zinc-800">`
- **行 90**: 检测到类名 `text-gray-700, text-zinc-300`
  代码：`<span className="font-medium text-gray-700 dark:text-zinc-300">`
- **行 99**: 检测到类名 `px-2, py-1, text-gray-500, text-gray-700, text-zinc-400, text-zinc-200, bg-gray-200, bg-zinc-700`
  代码：`className="px-2 py-1 text-gray-500 hover:text-gray-700 dark:text-zinc-400 dark:hover:text-zinc-200 hover:bg-gray-200 dark:hover:bg-zinc-700 rounded transition-colors"`
- **行 107**: 检测到类名 `px-2, py-1, shadow-sm`
  代码：`className="px-2.5 py-1 text-white rounded transition-colors shadow-sm"`
- **行 131**: 检测到类名 `w-0, flex`
  代码：`<Flex align="center" gap={3} className="min-w-0 flex-1">`
- **行 133**: 检测到类名 `text-green-600, text-green-500`
  代码：`<span className="text-green-600 dark:text-green-500">{edit.additions}</span>`
- **行 134**: 检测到类名 `text-red-500, text-red-400`
  代码：`<span className="text-red-500 dark:text-red-400">{edit.deletions}</span>`
- **行 139**: 检测到类名 `w-0`
  代码：`className="min-w-0 cursor-pointer hover:underline group/file"`
- **行 144**: 检测到类名 `text-gray-800, text-zinc-200, text-blue-500, text-blue-400`
  代码：`<span className="text-gray-800 dark:text-zinc-200 truncate font-medium group-hover/file:text-blue-500 dark:group-hover/file:text-blue-400">{edit.filePath.split(/[/\\]/).pop()}</span>`
- **行 145**: 检测到类名 `text-gray-400, text-zinc-500, text-blue-500, text-blue-400`
  代码：`<span className="text-gray-400 dark:text-zinc-500 truncate text-[11px] ml-1 group-hover/file:text-blue-500/80 dark:group-hover/file:text-blue-400/80">{edit.filePath}</span>`
- **行 150**: 检测到类名 `text-gray-400`
  代码：`{isLoading && <span className="text-gray-400 text-[11px]">...</span>}`
- **行 151**: 检测到类名 `text-green-600, text-green-500, px-1`
  代码：`{isAccepted && <span className="text-green-600 dark:text-green-500 text-[12px] px-1 font-medium">Accepted</span>}`
- **行 152**: 检测到类名 `text-red-500, text-red-400, px-1`
  代码：`{isRejected && <span className="text-red-500 dark:text-red-400 text-[12px] px-1 font-medium">Rejected</span>}`
- **行 160**: 检测到类名 `p-1, text-gray-400, text-red-500, bg-red-50, bg-red-500`
  代码：`className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded transition-colors"`
- **行 169**: 检测到类名 `p-1, text-gray-400, text-green-600, bg-green-50, bg-green-500`
  代码：`className="p-1 text-gray-400 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-500/10 rounded transition-colors"`

---

## 📄 [components\chat\ExecutionLog.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/chat/ExecutionLog.tsx)

### 🚫 侵入式原生 <svg> 图标 (3 处)
- **行 958**: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="spin-slow text-blue-500">`
- **行 969**: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-emerald-500">`
- **行 1207**: `<svg`

### 🚫 耦合的 Tailwind 样式名 (68 处)
- **行 719**: 检测到类名 `text-gray-500, text-zinc-400`
  代码：`<div className="whitespace-pre-wrap break-words leading-relaxed text-gray-500 dark:text-zinc-400 font-sans pr-2">`
- **行 733**: 检测到类名 `flex, rounded-md, bg-gray-50, bg-zinc-900, p-2, text-gray-500, h-48`
  代码：`<div className="flex flex-col gap-0.5 rounded-md bg-gray-50/50 dark:bg-zinc-900/50 p-2 font-mono text-[11.5px] text-gray-500 border border-gray-100/50 dark:border-zinc-800/50 mr-2 text-left max-h-48 overflow-y-auto pr-1">`
- **行 743**: 检测到类名 `flex, items-center, py-0, text-gray-800, text-zinc-200`
  代码：`<div key={idx} className="flex items-center gap-1.5 pl-2 py-0.5 select-none hover:text-gray-800 dark:hover:text-zinc-200">`
- **行 760**: 检测到类名 `flex, rounded-md, bg-gray-50, bg-zinc-900, p-2, text-gray-500, h-48`
  代码：`<div className="flex flex-col gap-0.5 rounded-md bg-gray-50/50 dark:bg-zinc-900/50 p-2 font-mono text-[11.5px] text-gray-500 border border-gray-100/50 dark:border-zinc-800/50 mr-2 text-left max-h-48 overflow-y-auto pr-1">`
- **行 761**: 检测到类名 `text-gray-400, text-zinc-500`
  代码：`<div className="text-gray-400 dark:text-zinc-500 mb-1.5 text-[11px] font-sans select-none pl-1">Analyzed Files:</div>`
- **行 767**: 检测到类名 `flex, items-center, py-1, text-gray-800, text-zinc-200`
  代码：`className="flex items-center gap-1.5 pl-1 py-1.5 select-none hover:text-gray-800 dark:hover:text-zinc-200 cursor-pointer transition-colors group/file"`
- **行 775**: 检测到类名 `text-gray-600, text-zinc-400, text-blue-500, text-blue-400`
  代码：`<span className="truncate group-hover/file:underline text-gray-600 dark:text-zinc-400 group-hover/file:text-blue-500 dark:group-hover/file:text-blue-400">{pathItem}</span>`
- **行 789**: 检测到类名 `flex, rounded-md, bg-gray-50, bg-zinc-900, p-2, text-gray-600, text-zinc-400`
  代码：`<div className="flex flex-col gap-1.5 rounded-md bg-gray-50/50 dark:bg-zinc-900/50 p-2.5 font-sans text-[12px] text-gray-600 dark:text-zinc-400 border border-gray-100/50 dark:border-zinc-800/50 mr-2 text-left">`
- **行 790**: 检测到类名 `grid`
  代码：`<div className="grid grid-cols-3 gap-y-1 gap-x-2">`
- **行 791**: 检测到类名 `text-gray-400, text-zinc-500`
  代码：`<span className="text-gray-400 dark:text-zinc-500">项目名称</span>`
- **行 792**: 检测到类名 `text-gray-800, text-zinc-300`
  代码：`<span className="col-span-2 font-mono text-gray-800 dark:text-zinc-300 font-medium">{parsed.rootName || '-'}</span>`
- **行 794**: 检测到类名 `text-gray-400, text-zinc-500`
  代码：`<span className="text-gray-400 dark:text-zinc-500">项目类型</span>`
- **行 795**: 检测到类名 `text-gray-800, text-zinc-300`
  代码：`<span className="col-span-2 font-mono text-gray-800 dark:text-zinc-300 font-medium">{parsed.projectType || '-'}</span>`
- **行 797**: 检测到类名 `text-gray-400, text-zinc-500`
  代码：`<span className="text-gray-400 dark:text-zinc-500">包管理器</span>`
- **行 798**: 检测到类名 `text-gray-800, text-zinc-300`
  代码：`<span className="col-span-2 font-mono text-gray-800 dark:text-zinc-300 font-medium">{parsed.packageManager || '-'}</span>`
- **行 802**: 检测到类名 `text-gray-400, text-zinc-500`
  代码：`<span className="text-gray-400 dark:text-zinc-500">根目录</span>`
- **行 803**: 检测到类名 `text-gray-800, text-zinc-300`
  代码：`<span className="col-span-2 font-mono text-gray-800 dark:text-zinc-300 break-all select-all">{parsed.rootPath}</span>`
- **行 809**: 检测到类名 `text-gray-400, text-zinc-500`
  代码：`<div className="text-gray-400 dark:text-zinc-500 mb-1.5 text-[11.5px]">项目内置脚本</div>`
- **行 810**: 检测到类名 `flex`
  代码：`<div className="flex flex-wrap gap-1">`
- **行 812**: 检测到类名 `flex, items-center, bg-zinc-800, px-2, py-0`
  代码：`<div key={key} className="inline-flex items-center gap-1.5 bg-white dark:bg-zinc-800 border border-gray-100 dark:border-zinc-700/80 px-2 py-0.5 rounded text-[11px] font-mono" title={String(cmd)}>`
- **行 813**: 检测到类名 `text-blue-500, text-blue-400`
  代码：`<span className="text-blue-500 dark:text-blue-400 font-bold">{key}:</span>`
- **行 814**: 检测到类名 `text-gray-500, text-zinc-400`
  代码：`<span className="text-gray-500 dark:text-zinc-400 truncate max-w-[200px]">{String(cmd)}</span>`
- **行 822**: 检测到类名 `text-gray-400, text-zinc-500`
  代码：`<div className="text-gray-400 dark:text-zinc-500 mb-1.5 text-[11.5px]">项目目录结构 (Depth: 3)</div>`
- **行 823**: 检测到类名 `flex, h-48, text-gray-500, p-2, rounded-md, bg-zinc-900`
  代码：`<div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto pr-1 font-mono text-[11px] text-gray-500 leading-normal border border-gray-100/50 dark:border-zinc-800/40 p-2 rounded-md bg-[#fafafa]/50 dark:bg-zinc-900/10">`
- **行 828**: 检测到类名 `text-gray-400`
  代码：`return <div key={idx} className="pl-1 text-gray-400">{line}</div>`
- **行 839**: 检测到类名 `flex, items-center, py-0, text-gray-800, text-zinc-200`
  代码：`<div key={idx} style={{ paddingLeft: pl }} className="flex items-center gap-1.5 select-none py-0.5 hover:text-gray-800 dark:hover:text-zinc-200">`
- **行 868**: 检测到类名 `flex, rounded-md, bg-gray-50, bg-zinc-900, p-2, text-gray-500`
  代码：`<div className="flex flex-col gap-1.5 rounded-md bg-gray-50/50 dark:bg-zinc-900/50 p-2 font-mono text-[11px] text-gray-500 border border-gray-100/50 dark:border-zinc-800/50 mr-2 text-left">`
- **行 869**: 检测到类名 `flex, rounded-md, p-2, text-gray-300, shadow-sm`
  代码：`<div className="flex flex-col gap-1.5 rounded-md bg-[#1e1e1e] dark:bg-[#111111] p-2.5 text-gray-300 shadow-sm overflow-hidden">`
- **行 871**: 检测到类名 `text-blue-400, flex, items-center`
  代码：`<div className="text-blue-400 select-none flex items-center gap-1.5 opacity-90 pb-1.5 border-b border-gray-700/60">`
- **行 876**: 检测到类名 `flex`
  代码：`<div className="flex gap-2 text-[11.5px] mt-0.5">`
- **行 877**: 检测到类名 `text-emerald-500`
  代码：`<span className="text-emerald-500 select-none font-bold">$</span>`
- **行 878**: 检测到类名 `text-gray-100`
  代码：`<span className="text-gray-100 whitespace-pre-wrap break-all">{cmd}</span>`
- **行 882**: 检测到类名 `h-48`
  代码：`<div className="max-h-48 overflow-auto pt-1.5 mt-0.5">`
- **行 883**: 检测到类名 `text-gray-400, text-zinc-600`
  代码：`<span className="text-gray-400 dark:text-zinc-600 mb-1 block select-none">Output:</span>`
- **行 884**: 检测到类名 `text-gray-600, text-zinc-400`
  代码：`<pre className="whitespace-pre-wrap break-all text-[10.5px] text-gray-600 dark:text-zinc-400 leading-relaxed">`
- **行 903**: 检测到类名 `flex, rounded-md, bg-gray-50, bg-zinc-900, p-2, text-gray-500`
  代码：`<div className="flex flex-col gap-1.5 rounded-md bg-gray-50/50 dark:bg-zinc-900/50 p-2 font-mono text-[11px] text-gray-500 border border-gray-100/50 dark:border-zinc-800/50 mr-2 text-left">`
- **行 905**: 检测到类名 `flex`
  代码：`<div className="flex flex-col gap-1">`
- **行 906**: 检测到类名 `text-gray-400, text-zinc-600`
  代码：`<span className="text-gray-400 dark:text-zinc-600 select-none">Parameters:</span>`
- **行 908**: 检测到类名 `flex, bg-zinc-900, p-1`
  代码：`<div className="flex flex-col gap-1 bg-white/50 dark:bg-zinc-900/30 rounded p-1.5 border border-gray-200/50 dark:border-zinc-800/50">`
- **行 910**: 检测到类名 `flex`
  代码：`<div key={k} className="flex gap-2">`
- **行 911**: 检测到类名 `text-blue-500, text-blue-400`
  代码：`<span className="text-blue-500/80 dark:text-blue-400/80 shrink-0">{k}:</span>`
- **行 912**: 检测到类名 `text-gray-600, text-zinc-400`
  代码：`<span className="text-gray-600 dark:text-zinc-400 whitespace-pre-wrap break-all">`
- **行 919**: 检测到类名 `text-gray-600, text-zinc-400`
  代码：`<span className="text-gray-600 dark:text-zinc-400 whitespace-pre-wrap break-all">{item.args}</span>`
- **行 924**: 检测到类名 `h-36`
  代码：`<div className="max-h-36 overflow-auto border-t border-gray-200/50 dark:border-zinc-800 pt-1.5 mt-0.5">`
- **行 925**: 检测到类名 `text-gray-400, text-zinc-600`
  代码：`<span className="text-gray-400 dark:text-zinc-600 mb-1 block select-none">Output:</span>`
- **行 926**: 检测到类名 `text-gray-600, text-zinc-400`
  代码：`<pre className="whitespace-pre-wrap break-all text-gray-600 dark:text-zinc-400 leading-relaxed text-[10.5px]">`
- **行 937**: 检测到类名 `rounded-md, p-2, text-gray-300, h-48`
  代码：`<div className="rounded-md bg-[#1e1e1e] dark:bg-[#111111] p-2.5 font-mono text-[10.5px] text-gray-300 border border-gray-700/30 mr-2 text-left max-h-48 overflow-y-auto">`
- **行 953**: 检测到类名 `flex, items-center, justify-between, py-1, bg-gray-100, bg-zinc-800, px-1`
  代码：`className="flex w-full items-center justify-between gap-3 text-left py-1 hover:bg-gray-100/50 dark:hover:bg-zinc-800/30 rounded px-1.5 transition-colors cursor-pointer select-none"`
- **行 956**: 检测到类名 `w-0, text-gray-500, text-zinc-400`
  代码：`<Flex align="center" gap={2} className="min-w-0 text-gray-500 dark:text-zinc-400">`
- **行 958**: 检测到类名 `text-blue-500`
  代码：`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="spin-slow text-blue-500">`
- **行 969**: 检测到类名 `text-emerald-500`
  代码：`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-emerald-500">`
- **行 975**: 检测到类名 `text-gray-400`
  代码：`<span className="shrink-0 text-[11px] text-gray-400 font-sans">`
- **行 998**: 检测到类名 `bg-gray-200, bg-zinc-800`
  代码：`<div className="absolute left-[7px] top-[16px] bottom-[-16px] w-[1px] bg-gray-200 dark:bg-zinc-800 z-0" />`
- **行 1002**: 检测到类名 `py-0, text-gray-500, text-zinc-400`
  代码：`<Flex align="start" gap={2} className="pl-[26px] py-0.5 text-[13px] text-gray-500 dark:text-zinc-400 font-sans opacity-90 leading-relaxed">`
- **行 1003**: 检测到类名 `text-blue-500, text-blue-400`
  代码：`<span className="animate-pulse text-blue-500 dark:text-blue-400 font-medium shrink-0 pt-[1px]">Working</span>`
- **行 1004**: 检测到类名 `w-0`
  代码：`<span className="whitespace-pre-wrap break-all min-w-0">{(item as any).content || item.detail}</span>`
- **行 1017**: 检测到类名 `w-0`
  代码：`<Flex align="center" gap={2} className="min-w-0 relative">`
- **行 1019**: 检测到类名 `w-4, h-4, flex, items-center, justify-center`
  代码：`<span className="shrink-0 z-10 bg-[#fcfcfc] dark:bg-[#1c1c1c] w-4 h-4 flex items-center justify-center">`
- **行 1033**: 检测到类名 `text-gray-700, text-zinc-300, text-blue-500, text-blue-400`
  代码：`className="text-gray-700 dark:text-zinc-300 font-mono text-[12px] hover:text-blue-500 dark:hover:text-blue-400 hover:underline cursor-pointer transition-colors"`
- **行 1144**: 检测到类名 `text-gray-700, text-zinc-300, bg-gray-100, bg-zinc-800, px-1, py-0`
  代码：`<code className="text-gray-700 dark:text-zinc-300 font-mono text-[11.5px] bg-gray-100/60 dark:bg-zinc-800/60 px-1.5 py-0.5 rounded">{item.target}</code>`
- **行 1156**: 检测到类名 `text-gray-700, text-zinc-300`
  代码：`<span className="text-gray-700 dark:text-zinc-300 font-mono text-[12px]">{item.target}</span>`
- **行 1160**: 检测到类名 `bg-gray-50, bg-zinc-900, bg-gray-100, bg-zinc-800, px-1, py-0`
  代码：`className="ml-1.5 font-mono text-[10.5px] cursor-pointer hover:underline border border-gray-200/40 dark:border-zinc-800 bg-gray-50/60 dark:bg-zinc-900/30 hover:bg-gray-100/50 dark:hover:bg-zinc-800/50 px-1.5 py-0.5 rounded transition-all select-none"`
- **行 1190**: 检测到类名 `text-emerald-600`
  代码：`<span className="text-emerald-600 font-medium">{item.additions}</span>`
- **行 1191**: 检测到类名 `mx-0, text-gray-300, text-zinc-700`
  代码：`<span className="mx-0.5 text-gray-300 dark:text-zinc-700 font-normal">/</span>`
- **行 1192**: 检测到类名 `text-rose-500`
  代码：`<span className="text-rose-500 font-medium">{item.deletions}</span>`
- **行 1201**: 检测到类名 `flex, h-1, w-1`
  代码：`<span className="flex h-1.5 w-1.5 relative mr-1.5">`
- **行 1202**: 检测到类名 `flex, rounded-full, bg-blue-500`
  代码：`<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-500 opacity-75"></span>`
- **行 1203**: 检测到类名 `flex, rounded-full, h-1, w-1, bg-blue-500`
  代码：`<span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500"></span>`

---

## 📄 [components\chat\MessageBody.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/chat/MessageBody.tsx)

### 🚫 侵入式原生 <svg> 图标 (2 处)
- **行 298**: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">`
- **行 305**: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">`

### 🚫 耦合的 Tailwind 样式名 (13 处)
- **行 81**: 检测到类名 `text-gray-900, text-gray-100`
  代码：`<strong key={`bold-${keyIdx++}`} className="font-semibold text-gray-900 dark:text-gray-100">`
- **行 345**: 检测到类名 `my-2`
  代码：`<div className="my-2.5">`
- **行 369**: 检测到类名 `flex, items-start`
  代码：`<div key={idx} style={{ paddingLeft: pl }} className="flex items-start gap-2 text-[14.5px] leading-relaxed mb-1">`
- **行 370**: 检测到类名 `text-gray-400`
  代码：`<span className="shrink-0 text-gray-400 select-none font-medium text-[13px] mt-[2px]">`
- **行 373**: 检测到类名 `w-0`
  代码：`<span className="min-w-0">`
- **行 416**: 检测到类名 `my-3, rounded-lg`
  代码：`<div className="my-3 overflow-x-auto border border-gray-200 dark:border-zinc-800 rounded-lg max-w-full">`
- **行 418**: 检测到类名 `bg-gray-50, bg-zinc-900`
  代码：`<thead className="bg-gray-50 dark:bg-zinc-900/50">`
- **行 421**: 检测到类名 `px-3, py-2, text-gray-700, text-zinc-300`
  代码：`<th key={i} className="px-3 py-2 font-semibold text-gray-700 dark:text-zinc-300">`
- **行 427**: 检测到类名 `bg-zinc-900`
  代码：`<tbody className="divide-y divide-gray-100 dark:divide-zinc-800/50 bg-white dark:bg-zinc-900/10">`
- **行 442**: 检测到类名 `px-3, py-1, text-gray-600, text-zinc-400`
  代码：`<td key={cellIdx} className="px-3 py-1.5 text-gray-600 dark:text-zinc-400">`
- **行 486**: 检测到类名 `my-4`
  代码：`return <hr key={idx} className="my-4 border-gray-200 dark:border-zinc-800" />`
- **行 499**: 检测到类名 `text-gray-800, text-zinc-200`
  代码：`<h2 key={idx} className="text-lg font-bold mt-4 mb-2 text-gray-800 dark:text-zinc-200">`
- **行 507**: 检测到类名 `text-gray-700, text-zinc-300`
  代码：`<h3 key={idx} className="text-md font-bold mt-3 mb-1.5 text-gray-700 dark:text-zinc-300">`

---

## 📄 [components\chat\TerminalPanel.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/chat/TerminalPanel.tsx)

### 🚫 侵入式原生 <svg> 图标 (3 处)
- **行 153**: `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">`
- **行 171**: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">`
- **行 204**: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">`

### 🚫 耦合的 Tailwind 样式名 (13 处)
- **行 116**: 检测到类名 `shadow-inner`
  代码：`className="bg-[#f8f9fa] border-t border-gray-200 shadow-inner relative select-text shrink-0 animate-fade-in"`
- **行 121**: 检测到类名 `h-1, bg-blue-500`
  代码：`className="absolute top-0 left-0 right-0 h-1 cursor-row-resize hover:bg-blue-500/80 transition-colors z-30"`
- **行 126**: 检测到类名 `px-4, py-1, text-gray-500`
  代码：`<Flex align="center" justify="between" className="px-4 py-1 bg-[#f0f2f5] border-b border-gray-200 text-[11px] text-gray-500 select-none shrink-0 overflow-x-auto">`
- **行 127**: 检测到类名 `w-0`
  代码：`<Flex align="center" gap={1} className="min-w-0">`
- **行 128**: 检测到类名 `text-gray-400`
  代码：`<span className="font-bold tracking-wider uppercase text-gray-400 mr-2 shrink-0">Terminal</span>`
- **行 131**: 检测到类名 `py-0`
  代码：`<Flex align="center" gap={1.5} className="overflow-x-auto py-0.5 pr-2 border-r border-gray-300 max-w-[400px]">`
- **行 151**: 检测到类名 `p-0, rounded-full, bg-gray-300, text-gray-700, text-gray-400, flex, items-center, justify-center`
  代码：`className="p-0.5 rounded-full hover:bg-gray-300 hover:text-gray-700 text-gray-400 cursor-pointer flex items-center justify-center"`
- **行 168**: 检测到类名 `p-1, bg-gray-200, text-gray-600, text-gray-800, flex, items-center, justify-center`
  代码：`className="p-1 rounded hover:bg-gray-200 text-gray-600 hover:text-gray-800 cursor-pointer flex items-center justify-center ml-1 shrink-0"`
- **行 183**: 检测到类名 `text-gray-800, text-gray-500`
  代码：`className="hover:text-gray-800 transition-colors cursor-pointer text-gray-500"`
- **行 192**: 检测到类名 `text-gray-800, text-gray-500`
  代码：`className="hover:text-gray-800 transition-colors cursor-pointer text-gray-500"`
- **行 201**: 检测到类名 `text-red-600, text-gray-400`
  代码：`className="hover:text-red-600 transition-colors cursor-pointer font-bold text-gray-400"`
- **行 213**: 检测到类名 `flex`
  代码：`<div className="flex-1 overflow-hidden relative">`
- **行 423**: 检测到类名 `p-2`
  代码：`className={`h-full w-full p-2 text-left ${visible ? 'block' : 'hidden'}`}`

---

## 📄 [components\chat\ThinkingBlock.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/chat/ThinkingBlock.tsx)

### 🚫 耦合的 Tailwind 样式名 (6 处)
- **行 19**: 检测到类名 `text-gray-400, flex, items-center`
  代码：`<div className="text-gray-400 text-[13px] mb-3 flex items-center gap-2">`
- **行 20**: 检测到类名 `flex, h-3, w-3`
  代码：`<span className="flex h-3 w-3 relative">`
- **行 21**: 检测到类名 `flex, rounded-full, bg-gray-400`
  代码：`<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-gray-400 opacity-75"></span>`
- **行 22**: 检测到类名 `flex, rounded-full, h-3, w-3, bg-gray-300`
  代码：`<span className="relative inline-flex rounded-full h-3 w-3 bg-gray-300"></span>`
- **行 32**: 检测到类名 `flex, items-center, text-gray-400, text-gray-600, bg-gray-100, px-2, py-0, rounded-md`
  代码：`className="inline-flex items-center gap-1.5 text-gray-400 text-[13px] hover:text-gray-600 transition-colors cursor-pointer select-none mb-1.5 bg-gray-100/50 px-2 py-0.5 rounded-md"`
- **行 40**: 检测到类名 `py-1, text-gray-500`
  代码：`<div className="border-l-[3px] border-gray-200 ml-[3px] pl-4 py-1 text-gray-500 text-[13.5px] whitespace-pre-wrap break-all leading-relaxed font-[400] relative">`

---

## 📄 [components\chat\ToolCallLog.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/chat/ToolCallLog.tsx)

### 🚫 耦合的 Tailwind 样式名 (19 处)
- **行 121**: 检测到类名 `rounded-xl, bg-gray-50, px-3, py-2, text-gray-600`
  代码：`<div className="mb-3 rounded-xl border border-gray-100 bg-gray-50/70 px-3 py-2 text-[13px] text-gray-600">`
- **行 124**: 检测到类名 `flex, items-center, justify-between`
  代码：`className="flex w-full items-center justify-between gap-3 text-left"`
- **行 128**: 检测到类名 `w-0`
  代码：`<Flex align="center" gap={2} className="min-w-0">`
- **行 129**: 检测到类名 `h-2, w-2, rounded-full, bg-blue-500, bg-green-500`
  代码：`<span className={`h-2 w-2 rounded-full ${hasRunning ? 'animate-pulse bg-blue-500' : 'bg-green-500'}`} />`
- **行 130**: 检测到类名 `text-gray-700`
  代码：`<span className="truncate font-medium text-gray-700">{getSummary(sortedLogs)}</span>`
- **行 131**: 检测到类名 `text-gray-400`
  代码：`<span className="shrink-0 text-gray-400">共 {sortedLogs.length} 项</span>`
- **行 133**: 检测到类名 `text-gray-400`
  代码：`<span className="shrink-0 text-[12px] text-gray-400">{expanded ? '收起' : '展开'}</span>`
- **行 142**: 检测到类名 `px-1, py-0, text-gray-400, text-gray-600`
  代码：`className="w-max rounded px-1.5 py-0.5 text-[12px] text-gray-400 hover:bg-white hover:text-gray-600"`
- **行 155**: 检测到类名 `rounded-md, px-1, py-0`
  代码：`<details key={log.id} className="group rounded-md px-1 py-0.5" open={log.status === 'running' || log.status === 'error'}>`
- **行 156**: 检测到类名 `flex, items-center, justify-between, rounded-md, px-1, py-0`
  代码：`<summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md px-1 py-0.5 hover:bg-white/70">`
- **行 158**: 检测到类名 `w-0`
  代码：`<Flex align="center" gap={2} className="min-w-0">`
- **行 159**: 检测到类名 `h-1, w-1, rounded-full, bg-blue-400, bg-red-400, bg-gray-300`
  代码：`<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${log.status === 'running' ? 'animate-pulse bg-blue-400' : log.status === 'error' ? 'bg-red-400' : 'bg-gray-300'}`} />`
- **行 160**: 检测到类名 `text-gray-600`
  代码：`<span className="shrink-0 text-gray-600">{getVerb(log)}</span>`
- **行 161**: 检测到类名 `text-gray-400`
  代码：`{target && <span className="truncate font-mono text-[12px] text-gray-400">{target}</span>}`
- **行 163**: 检测到类名 `text-gray-400`
  代码：`{duration && <span className="shrink-0 font-mono text-[11px] text-gray-400">{duration}</span>}`
- **行 169**: 检测到类名 `text-gray-400`
  代码：`<div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">参数</div>`
- **行 170**: 检测到类名 `h-24, p-2, text-gray-500`
  代码：`<pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 font-mono text-[12px] text-gray-500">{formatToolArgs(log.args)}</pre>`
- **行 175**: 检测到类名 `text-gray-400`
  代码：`<div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">`
- **行 178**: 检测到类名 `h-24, p-2, text-red-600, text-gray-500`
  代码：`<pre className={`max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 font-mono text-[12px] ${log.status === 'error' ? 'text-red-600' : 'text-gray-500'}`}>{result}</pre>`

---

## 📄 [components\ErrorBoundary.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/ErrorBoundary.tsx)

### 🚫 耦合的 Tailwind 样式名 (11 处)
- **行 44**: 检测到类名 `p-6`
  代码：`<Flex align="center" justify="center" className="min-h-screen w-full bg-[#f8f9fa] p-6 font-sans">`
- **行 45**: 检测到类名 `p-8, shadow-lg`
  代码：`<Card variant="default" rounded="xl" className="max-w-2xl w-full border border-red-100 p-8 shadow-lg">`
- **行 47**: 检测到类名 `text-red-500`
  代码：`<Flex align="center" gap={3} className="text-red-500 mb-4">`
- **行 48**: 检测到类名 `h-8, w-8`
  代码：`<svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">`
- **行 54**: 检测到类名 `text-gray-600`
  代码：`<p className="text-gray-600 mb-6">`
- **行 58**: 检测到类名 `bg-red-50, rounded-lg, p-4`
  代码：`<div className="bg-red-50 rounded-lg p-4 mb-6 overflow-x-auto border border-red-100">`
- **行 59**: 检测到类名 `text-red-800`
  代码：`<div className="text-sm font-semibold text-red-800 mb-2">错误信息：</div>`
- **行 60**: 检测到类名 `text-red-600`
  代码：`<code className="text-sm text-red-600 break-words whitespace-pre-wrap">`
- **行 65**: 检测到类名 `text-red-800`
  代码：`<div className="text-sm font-semibold text-red-800 mb-2">组件调用栈：</div>`
- **行 66**: 检测到类名 `text-red-700`
  代码：`<pre className="text-xs text-red-700 overflow-x-auto whitespace-pre-wrap leading-relaxed">`
- **行 78**: 检测到类名 `px-6, py-2, rounded-lg, shadow-sm`
  代码：`className="px-6 py-2 rounded-lg font-medium shadow-sm text-white"`

---

## 📄 [components\modals\ProjectMemoryModal.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/modals/ProjectMemoryModal.tsx)

### 🚫 侵入式原生 <svg> 图标 (1 处)
- **行 54**: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`

### 🚫 耦合的 Tailwind 样式名 (11 处)
- **行 48**: 检测到类名 `p-4`
  代码：`<Flex align="center" justify="center" className="fixed inset-0 z-[9999] bg-black/40 backdrop-blur-sm p-4">`
- **行 51**: 检测到类名 `px-5, py-4, bg-gray-50`
  代码：`<Flex align="center" justify="between" className="px-5 py-4 border-b border-gray-100 bg-gray-50/50">`
- **行 52**: 检测到类名 `text-gray-800`
  代码：`<h2 className="text-lg font-medium text-gray-800">项目记忆</h2>`
- **行 58**: 检测到类名 `flex, p-5`
  代码：`<Stack className="flex-1 overflow-y-auto p-5 text-sm" gap={6}>`
- **行 60**: 检测到类名 `text-gray-700`
  代码：`<label className="block text-gray-700 font-medium mb-2">架构建议 (Architecture)</label>`
- **行 62**: 检测到类名 `rounded-lg, p-3, text-gray-800`
  代码：`className="w-full border border-gray-300 rounded-lg p-3 text-gray-800 min-h-[100px] outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"`
- **行 70**: 检测到类名 `text-gray-700`
  代码：`<label className="block text-gray-700 font-medium mb-2">技术栈 (Tech Stack)</label>`
- **行 73**: 检测到类名 `rounded-lg, p-3, text-gray-800`
  代码：`className="w-full border border-gray-300 rounded-lg p-3 text-gray-800 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"`
- **行 84**: 检测到类名 `text-gray-700`
  代码：`<label className="block text-gray-700 font-medium mb-2">全局规则 (Global Rules)</label>`
- **行 86**: 检测到类名 `rounded-lg, p-3, text-gray-800`
  代码：`className="w-full border border-gray-300 rounded-lg p-3 text-gray-800 min-h-[120px] outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all leading-relaxed"`
- **行 97**: 检测到类名 `px-5, py-4, bg-gray-50`
  代码：`<Flex align="center" justify="between" className="px-5 py-4 border-t border-gray-100 bg-gray-50/50">`

---

## 📄 [components\modals\TaskHistoryModal.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/modals/TaskHistoryModal.tsx)

### 🚫 侵入式原生 <svg> 图标 (2 处)
- **行 42**: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
- **行 81**: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`

### 🚫 耦合的 Tailwind 样式名 (19 处)
- **行 36**: 检测到类名 `p-4`
  代码：`<Flex align="center" justify="center" className="fixed inset-0 z-[9999] bg-black/40 backdrop-blur-sm p-4">`
- **行 39**: 检测到类名 `px-5, py-4, bg-gray-50`
  代码：`<Flex align="center" justify="between" className="px-5 py-4 border-b border-gray-100 bg-gray-50/50 shrink-0">`
- **行 40**: 检测到类名 `text-gray-800`
  代码：`<h2 className="text-lg font-medium text-gray-800">任务历史</h2>`
- **行 41**: 检测到类名 `p-1, text-gray-400, text-gray-600, bg-gray-200`
  代码：`<Button variant="ghost" size="none" onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-200/50">`
- **行 46**: 检测到类名 `flex, p-5, bg-gray-50`
  代码：`<Stack className="flex-1 overflow-y-auto p-5 bg-gray-50/30">`
- **行 48**: 检测到类名 `text-gray-400, py-10`
  代码：`<div className="text-center text-gray-400 py-10">加载中...</div>`
- **行 50**: 检测到类名 `text-gray-400, py-10`
  代码：`<div className="text-center text-gray-400 py-10">暂无任务记录</div>`
- **行 60**: 检测到类名 `px-4, py-3`
  代码：`className="px-4 py-3 cursor-pointer"`
- **行 63**: 检测到类名 `w-0`
  代码：`<Stack className="min-w-0">`
- **行 64**: 检测到类名 `text-gray-800`
  代码：`<span className="text-sm font-medium text-gray-800 truncate">{task.title || '未命名任务'}</span>`
- **行 65**: 检测到类名 `text-gray-500`
  代码：`<span className="text-xs text-gray-500 mt-1">{new Date(task.timestamp).toLocaleString()}</span>`
- **行 77**: 检测到类名 `p-1, text-gray-400, text-red-500, bg-red-50`
  代码：`className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"`
- **行 87**: 检测到类名 `px-4, text-gray-700, bg-gray-50`
  代码：`<div className="px-4 pb-4 border-t border-gray-100 mt-2 pt-3 text-sm text-gray-700 bg-gray-50/50">`
- **行 90**: 检测到类名 `text-gray-500`
  代码：`<h4 className="text-xs font-semibold text-gray-500 mb-1">描述</h4>`
- **行 94**: 检测到类名 `grid`
  代码：`<div className="grid grid-cols-2 gap-4">`
- **行 97**: 检测到类名 `text-gray-500`
  代码：`<h4 className="text-xs font-semibold text-gray-500 mb-1">修改的文件</h4>`
- **行 98**: 检测到类名 `text-gray-600`
  代码：`<ul className="list-disc list-inside text-gray-600">`
- **行 107**: 检测到类名 `text-gray-500`
  代码：`<h4 className="text-xs font-semibold text-gray-500 mb-1">执行的命令</h4>`
- **行 108**: 检测到类名 `text-gray-600`
  代码：`<ul className="list-disc list-inside text-gray-600 font-mono text-[11px]">`

---

## 📄 [components\PromptArea.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/PromptArea.tsx)

### 🚫 耦合的 Tailwind 样式名 (17 处)
- **行 73**: 检测到类名 `px-4`
  代码：`<div className="max-w-3xl mx-auto px-4 relative">`
- **行 74**: 检测到类名 `p-3`
  代码：`<Card variant="default" rounded="lg" className="shadow-[0_2px_12px_rgba(0,0,0,0.06)] border-gray-100 p-3 relative z-20">`
- **行 83**: 检测到类名 `p-1`
  代码：`className="w-full bg-transparent resize-none outline-none text-[15px] placeholder-gray-400 p-1 min-h-[44px]"`
- **行 88**: 检测到类名 `text-gray-400`
  代码：`<Flex align="center" gap={3} className="text-gray-400">`
- **行 89**: 检测到类名 `bg-gray-100, p-1`
  代码：`<Button variant="ghost" size="none" className="hover:bg-gray-100 p-1 rounded">`
- **行 92**: 检测到类名 `flex, items-center, text-gray-600`
  代码：`<Button variant="ghost" size="none" className="flex items-center gap-1 text-[13px] hover:text-gray-600">`
- **行 103**: 检测到类名 `p-1, text-gray-400, text-gray-600, bg-gray-100`
  代码：`className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"`
- **行 116**: 检测到类名 `flex, items-center, text-gray-500, text-gray-800, px-2, py-1, bg-gray-100`
  代码：`className="flex items-center gap-1 text-[13px] text-gray-500 hover:text-gray-800 px-2 py-1 rounded hover:bg-gray-100 max-w-[220px] truncate"`
- **行 126**: 检测到类名 `w-64, py-1`
  代码：`<Card variant="default" className="absolute right-0 bottom-[120%] mb-1 w-64 py-1.5 z-[50] text-sm">`
- **行 127**: 检测到类名 `px-3, py-1, text-gray-400`
  代码：`<div className="px-3 py-1.5 text-xs text-gray-400 font-medium tracking-wide">Provider / 模型</div>`
- **行 130**: 检测到类名 `px-3, py-3, text-gray-400`
  代码：`<div className="px-3 py-3 text-xs text-gray-400 text-center">暂无 Provider</div>`
- **行 145**: 检测到类名 `text-blue-400`
  代码：`{p.id === activeProviderId && <span className="text-[10px] text-blue-400">✓</span>}`
- **行 164**: 检测到类名 `text-gray-400`
  代码：`<span className="text-[10px] text-gray-400">`
- **行 177**: 检测到类名 `bg-gray-100, my-1`
  代码：`<div className="h-px bg-gray-100 my-1"></div>`
- **行 181**: 检测到类名 `px-3, py-2, bg-gray-50, text-blue-600`
  代码：`className="px-3 py-2 hover:bg-gray-50 cursor-pointer text-blue-600"`
- **行 199**: 检测到类名 `rounded-full, flex, items-center, justify-center, shadow-sm`
  代码：`className="w-[32px] h-[32px] rounded-full flex items-center justify-center shadow-sm text-white"`
- **行 210**: 检测到类名 `rounded-full, flex, items-center, justify-center, shadow-sm`
  代码：`className="w-[32px] h-[32px] rounded-full flex items-center justify-center shadow-sm"`

---

## 📄 [components\SettingsPanel.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/SettingsPanel.tsx)

### 🚫 耦合的 Tailwind 样式名 (22 处)
- **行 93**: 检测到类名 `flex`
  代码：`<div className="flex-1 bg-bg-panel overflow-y-auto border-l border-border">`
- **行 94**: 检测到类名 `p-8`
  代码：`<div className="p-8 max-w-3xl">`
- **行 95**: 检测到类名 `flex, items-center, justify-between`
  代码：`<div className="flex items-center justify-between mb-8">`
- **行 96**: 检测到类名 `flex, items-center`
  代码：`<div className="flex items-center gap-3">`
- **行 100**: 检测到类名 `bg-green-500, text-green-500, px-2, py-0, rounded-full`
  代码：`<span className="text-[11px] bg-green-500/20 text-green-500 px-2 py-0.5 rounded-full font-medium">已启用</span>`
- **行 105**: 检测到类名 `text-red-500, p-1`
  代码：`<Button variant="ghost" size="none" className="text-text-muted hover:text-red-500 transition-colors p-1" onClick={onDelete} title="删除该提供商">`
- **行 154**: 检测到类名 `flex, items-center`
  代码：`<div className="relative flex items-center">`
- **行 165**: 检测到类名 `p-1`
  代码：`className="absolute right-3 text-text-muted hover:text-text-main p-1 transition-colors"`
- **行 176**: 检测到类名 `rounded-lg, p-3`
  代码：`<div className="bg-bg-input border border-border rounded-lg p-3 space-y-3">`
- **行 177**: 检测到类名 `flex, items-center`
  代码：`<label className="flex items-center gap-2 text-[13px] text-text-main cursor-pointer">`
- **行 186**: 检测到类名 `px-3, py-2`
  代码：`className="text-[13px] px-3 py-2"`
- **行 209**: 检测到类名 `rounded-lg`
  代码：`<div className="bg-bg-input border border-border rounded-lg overflow-hidden">`
- **行 211**: 检测到类名 `flex, items-center, p-3`
  代码：`<div key={m.id || idx} className="flex items-center gap-3 p-3 border-b border-border last:border-0 hover:bg-bg-hover transition-colors">`
- **行 212**: 检测到类名 `flex`
  代码：`<div className="flex-1">`
- **行 221**: 检测到类名 `w-32, flex, items-center, justify-end`
  代码：`<div className="w-32 flex items-center justify-end gap-1">`
- **行 225**: 检测到类名 `w-16`
  代码：`className="w-16 text-[13px] text-right text-text-light"`
- **行 231**: 检测到类名 `p-1`
  代码：`<Button variant="danger" size="none" className="p-1 cursor-pointer" onClick={() => removeModel(idx)}>`
- **行 237**: 检测到类名 `p-3`
  代码：`<div className="p-3 bg-bg-app border-t border-border">`
- **行 241**: 检测到类名 `flex, items-center`
  代码：`className="text-[13px] text-text-muted hover:text-text-main flex items-center gap-1.5 transition-colors"`
- **行 252**: 检测到类名 `flex, items-center, justify-between`
  代码：`<div className="flex items-center justify-between pt-4">`
- **行 253**: 检测到类名 `flex, items-center`
  代码：`<div className="flex items-center gap-3 border-t border-border pt-6 flex-1">`
- **行 273**: 检测到类名 `px-2, text-green-500, text-red-500`
  代码：`<span className={`text-[13px] px-2 ${testResult.success ? 'text-green-500' : 'text-red-500'}`}>`

---

## 📄 [components\Sidebar.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/Sidebar.tsx)

### 🚫 耦合的 Tailwind 样式名 (59 处)
- **行 102**: 检测到类名 `flex, justify-between, text-gray-800`
  代码：`className="shrink-0 h-screen bg-[#f8f9fa] border-r border-gray-200 flex flex-col justify-between text-sm text-gray-800 font-sans relative"`
- **行 107**: 检测到类名 `w-1, bg-blue-500, bg-blue-600`
  代码：`className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-500 active:bg-blue-600 transition-colors z-10"`
- **行 133**: 检测到类名 `flex`
  代码：`<Stack className="flex-1 overflow-hidden">`
- **行 135**: 检测到类名 `p-3`
  代码：`<Stack className="p-3" gap="4px">`
- **行 139**: 检测到类名 `px-3, py-2, rounded-md, bg-gray-200, text-gray-700`
  代码：`className="w-full text-left px-3 py-2 rounded-md hover:bg-gray-200/50 text-gray-700 transition-colors"`
- **行 143**: 检测到类名 `text-gray-500`
  代码：`<span className="text-gray-500"><Pencil /></span>`
- **行 147**: 检测到类名 `px-3, py-2, rounded-md, bg-gray-200, text-gray-700`
  代码：`<Button variant="ghost" size="none" className="w-full text-left px-3 py-2 rounded-md hover:bg-gray-200/50 text-gray-700 transition-colors">`
- **行 149**: 检测到类名 `text-gray-500`
  代码：`<span className="text-gray-500"><Search /></span><span>搜索</span>`
- **行 152**: 检测到类名 `px-3, py-2, rounded-md, bg-gray-200, text-gray-700`
  代码：`<Button variant="ghost" size="none" className="w-full text-left px-3 py-2 rounded-md hover:bg-gray-200/50 text-gray-700 transition-colors">`
- **行 154**: 检测到类名 `text-gray-500`
  代码：`<span className="text-gray-500"><Grid /></span><span>插件</span>`
- **行 157**: 检测到类名 `px-3, py-2, rounded-md, bg-gray-200, text-gray-700`
  代码：`<Button variant="ghost" size="none" className="w-full text-left px-3 py-2 rounded-md hover:bg-gray-200/50 text-gray-700 transition-colors">`
- **行 159**: 检测到类名 `text-gray-500`
  代码：`<span className="text-gray-500"><Clock /></span><span>自动化</span>`
- **行 165**: 检测到类名 `flex, px-3, py-2`
  代码：`<div className="flex-1 overflow-y-auto px-3 py-2 mt-2">`
- **行 166**: 检测到类名 `px-3`
  代码：`<Flex align="center" justify="between" className="px-3 mb-2">`
- **行 167**: 检测到类名 `text-gray-400`
  代码：`<div className="text-xs text-gray-400 font-medium tracking-wide">项目</div>`
- **行 168**: 检测到类名 `text-gray-400, flex`
  代码：`<Flex align="center" gap={1} className="text-gray-400 flex-shrink-0">`
- **行 175**: 检测到类名 `w-3, h-3`
  代码：`{isAnyCollapsed ? <ExpandAll className="w-3.5 h-3.5" /> : <CollapseAll className="w-3.5 h-3.5" />}`
- **行 183**: 检测到类名 `w-3, h-3`
  代码：`<FolderPlus className="w-3.5 h-3.5" />`
- **行 189**: 检测到类名 `text-gray-400, px-3, py-4`
  代码：`<p className="text-xs text-gray-400 px-3 py-4 text-center">`
- **行 215**: 检测到类名 `text-gray-400, w-3, h-3, flex`
  代码：`className="transform transition-transform text-gray-400 w-3.5 h-3.5 flex-shrink-0"`
- **行 218**: 检测到类名 `text-gray-400, flex`
  代码：`<span className="text-gray-400 flex-shrink-0"><Folder /></span>`
- **行 229**: 检测到类名 `p-1, bg-gray-300, text-gray-500, text-gray-900`
  代码：`className="p-1 hover:bg-gray-300 rounded text-gray-500 hover:text-gray-900 transition-colors cursor-pointer"`
- **行 237**: 检测到类名 `w-3, h-3`
  代码：`<MessagePlus className="w-3.5 h-3.5" />`
- **行 243**: 检测到类名 `p-1, bg-gray-300, text-gray-500, text-gray-900`
  代码：`className="p-1 hover:bg-gray-300 rounded text-gray-500 hover:text-gray-900 transition-colors cursor-pointer bg-transparent border-none outline-none"`
- **行 275**: 检测到类名 `text-gray-400, flex`
  代码：`<span className="text-gray-400 flex-shrink-0"><Message /></span>`
- **行 276**: 检测到类名 `flex`
  代码：`<span className="truncate flex-1">{session.summary}</span>`
- **行 280**: 检测到类名 `text-gray-400, flex`
  代码：`<span className="text-[11px] text-gray-400 flex-shrink-0 ml-1 group-hover/session:hidden">`
- **行 283**: 检测到类名 `flex`
  代码：`<Flex align="center" gap={1} className="hidden group-hover/session:flex ml-1 flex-shrink-0">`
- **行 287**: 检测到类名 `p-1, bg-gray-300, text-gray-500, text-gray-900`
  代码：`className="p-1 hover:bg-gray-300 rounded text-gray-500 hover:text-gray-900 transition-colors"`
- **行 294**: 检测到类名 `w-3, h-3`
  代码：`<Archive className="w-3.5 h-3.5" />`
- **行 299**: 检测到类名 `p-1, bg-gray-300, text-gray-500, text-red-600`
  代码：`className="p-1 hover:bg-gray-300 rounded text-gray-500 hover:text-red-600 transition-colors"`
- **行 306**: 检测到类名 `w-3, h-3`
  代码：`<Trash className="w-3.5 h-3.5" />`
- **行 321**: 检测到类名 `text-gray-600`
  代码：`<span className="text-[11px] text-gray-600 font-medium whitespace-nowrap">`
- **行 327**: 检测到类名 `p-0, bg-gray-300, text-green-600`
  代码：`className="p-0.5 hover:bg-gray-300 rounded text-green-600 transition-colors"`
- **行 339**: 检测到类名 `w-3, h-3`
  代码：`<Check className="w-3.5 h-3.5" />`
- **行 344**: 检测到类名 `p-0, bg-gray-300, text-red-500`
  代码：`className="p-0.5 hover:bg-gray-300 rounded text-red-500 transition-colors"`
- **行 351**: 检测到类名 `w-3, h-3`
  代码：`<Close className="w-3.5 h-3.5" />`
- **行 365**: 检测到类名 `py-1, text-gray-400, text-gray-600`
  代码：`className="pl-4 py-1 text-xs text-gray-400 hover:text-gray-600 cursor-pointer"`
- **行 389**: 检测到类名 `text-gray-400, flex`
  代码：`<span className="text-gray-400 flex-shrink-0"><Message /></span>`
- **行 390**: 检测到类名 `flex`
  代码：`<span className="truncate flex-1 line-through decoration-gray-300">{session.summary}</span>`
- **行 394**: 检测到类名 `text-gray-400, flex`
  代码：`<span className="text-[11px] text-gray-400 flex-shrink-0 ml-1 group-hover/session:hidden">`
- **行 397**: 检测到类名 `flex`
  代码：`<Flex align="center" gap={1} className="hidden group-hover/session:flex ml-1 flex-shrink-0">`
- **行 401**: 检测到类名 `p-1, bg-gray-300, text-gray-500, text-gray-900`
  代码：`className="p-1 hover:bg-gray-300 rounded text-gray-500 hover:text-gray-900 transition-colors"`
- **行 408**: 检测到类名 `w-3, h-3`
  代码：`<Unarchive className="w-3.5 h-3.5" />`
- **行 413**: 检测到类名 `p-1, bg-gray-300, text-gray-500, text-red-600`
  代码：`className="p-1 hover:bg-gray-300 rounded text-gray-500 hover:text-red-600 transition-colors"`
- **行 420**: 检测到类名 `w-3, h-3`
  代码：`<Trash className="w-3.5 h-3.5" />`
- **行 435**: 检测到类名 `text-gray-600`
  代码：`<span className="text-[11px] text-gray-600 font-medium whitespace-nowrap">`
- **行 441**: 检测到类名 `p-0, bg-gray-300, text-green-600`
  代码：`className="p-0.5 hover:bg-gray-300 rounded text-green-600 transition-colors"`
- **行 453**: 检测到类名 `w-3, h-3`
  代码：`<Check className="w-3.5 h-3.5" />`
- **行 458**: 检测到类名 `p-0, bg-gray-300, text-red-500`
  代码：`className="p-0.5 hover:bg-gray-300 rounded text-red-500 transition-colors"`
- **行 465**: 检测到类名 `w-3, h-3`
  代码：`<Close className="w-3.5 h-3.5" />`
- **行 484**: 检测到类名 `p-3`
  代码：`<div className="p-3">`
- **行 485**: 检测到类名 `px-3, py-2, rounded-md, bg-gray-200, text-gray-700`
  代码：`<Button variant="ghost" size="none" className="w-full text-left px-3 py-2 rounded-md hover:bg-gray-200/50 text-gray-700 transition-colors">`
- **行 487**: 检测到类名 `text-gray-500`
  代码：`<span className="text-gray-500"><Gear /></span><span>设置</span>`
- **行 497**: 检测到类名 `shadow-xl, rounded-lg, py-1, w-48`
  代码：`className="fixed bg-white border border-gray-100 shadow-xl rounded-lg py-1 z-[9999] text-sm font-normal w-48"`
- **行 500**: 检测到类名 `px-3, py-1, bg-gray-100, flex, items-center, text-gray-700`
  代码：`<div className="px-3 py-1.5 hover:bg-gray-100 flex items-center gap-2 cursor-pointer text-gray-700">在资源管理器中打开</div>`
- **行 501**: 检测到类名 `px-3, py-1, bg-gray-100, flex, items-center, text-gray-700`
  代码：`<div className="px-3 py-1.5 hover:bg-gray-100 flex items-center gap-2 cursor-pointer text-gray-700">重命名项目</div>`
- **行 502**: 检测到类名 `bg-gray-100, my-1`
  代码：`<div className="h-px bg-gray-100 my-1"></div>`
- **行 503**: 检测到类名 `px-3, py-1, bg-red-50, text-red-600, flex, items-center`
  代码：`<div className="px-3 py-1.5 hover:bg-red-50 text-red-600 flex items-center gap-2 cursor-pointer">移除此项目</div>`

---

## 📄 [components\TopBar.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/TopBar.tsx)

### 🚫 侵入式原生 <svg> 图标 (7 处)
- **行 271**: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">`
- **行 286**: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">`
- **行 301**: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">`
- **行 317**: `<svg width="12" height="12" viewBox="0 0 12 12">`
- **行 327**: `<svg width="12" height="12" viewBox="0 0 12 12">`
- **行 332**: `<svg width="12" height="12" viewBox="0 0 12 12">`
- **行 342**: `<svg width="12" height="12" viewBox="0 0 12 12">`

### 🚫 耦合的 Tailwind 样式名 (12 处)
- **行 167**: 检测到类名 `bg-gray-100, px-2, py-0`
  代码：`className="bg-gray-100 border border-gray-200/80 rounded px-2 py-0.5 text-[13px] font-sans select-none"`
- **行 171**: 检测到类名 `px-1, text-gray-700`
  代码：`<div className="px-1.5 font-semibold text-gray-700 truncate max-w-[150px]">`
- **行 176**: 检测到类名 `h-3, bg-gray-300, mx-1`
  代码：`<div className="h-3.5 w-px bg-gray-300/80 mx-1"></div>`
- **行 198**: 检测到类名 `h-3, bg-gray-300, mx-1`
  代码：`<div className="h-3 w-[1px] bg-gray-300 mx-1"></div>`
- **行 204**: 检测到类名 `flex, items-center, justify-center, text-gray-500, text-blue-600, px-1`
  代码：`className="flex items-center justify-center text-gray-500 hover:text-blue-600 transition-colors px-1"`
- **行 216**: 检测到类名 `w-48, py-1, text-gray-700`
  代码：`className="absolute left-0 top-[110%] w-48 py-1.5 z-[999] text-sm text-gray-700 font-normal font-sans"`
- **行 219**: 检测到类名 `px-3, py-1, text-gray-400`
  代码：`<div className="px-3 py-1 text-xs text-gray-400 font-medium tracking-wide border-b border-gray-50 mb-1">选择目标 IDE</div>`
- **行 225**: 检测到类名 `px-3, py-2, bg-gray-50, text-blue-600, bg-blue-50`
  代码：`className={`px-3 py-2 cursor-pointer hover:bg-gray-50 ${selectedIDE === item.id ? 'text-blue-600 font-semibold bg-blue-50/20' : ''}`}`
- **行 241**: 检测到类名 `text-blue-500`
  代码：`{selectedIDE === item.id && <span className="text-xs text-blue-500 font-bold">✓</span>}`
- **行 265**: 检测到类名 `text-gray-600, bg-gray-100`
  代码：`className={`user-menu-btn ${!hasWorkspace ? 'opacity-35 cursor-not-allowed' : 'text-gray-600 hover:bg-gray-100'}`}`
- **行 280**: 检测到类名 `text-gray-600, bg-gray-100`
  代码：`className={`user-menu-btn ${!hasWorkspace ? 'opacity-35 cursor-not-allowed' : 'text-gray-600 hover:bg-gray-100'}`}`
- **行 295**: 检测到类名 `bg-blue-100, text-blue-600, bg-blue-200, text-gray-600, bg-gray-100`
  代码：`className={`user-menu-btn ${!hasWorkspace ? 'opacity-35 cursor-not-allowed' : terminalOpen ? 'bg-blue-100 text-blue-600 hover:bg-blue-200' : 'text-gray-600 hover:bg-gray-100'}`}`

---

## 📄 [components\TrashItem.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/TrashItem.tsx)

### 🚫 耦合的 Tailwind 样式名 (4 处)
- **行 24**: 检测到类名 `px-4, py-3, rounded-lg`
  代码：`<Flex align="center" justify="between" className="px-4 py-3 bg-bg-app border border-border rounded-lg hover:border-border-hover transition-colors">`
- **行 28**: 检测到类名 `text-orange-500, bg-orange-500, px-1, py-0`
  代码：`<span className="text-[11px] text-orange-500 bg-orange-500/10 px-1.5 py-0.5 rounded font-medium">`
- **行 40**: 检测到类名 `px-3, py-1, rounded-md`
  代码：`className="px-3 py-1.5 text-[12px] font-medium rounded-md text-text-main border border-border"`
- **行 48**: 检测到类名 `px-3, py-1, rounded-md`
  代码：`className="px-3 py-1.5 text-[12px] font-medium rounded-md"`

---

## 📄 [components\TrashPanel.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/TrashPanel.tsx)

### 🚫 耦合的 Tailwind 样式名 (7 处)
- **行 50**: 检测到类名 `flex`
  代码：`<Stack className="flex-1 overflow-hidden bg-bg-panel border-l border-border">`
- **行 51**: 检测到类名 `p-8`
  代码：`<div className="p-8 pb-4 shrink-0">`
- **行 58**: 检测到类名 `flex, px-8`
  代码：`<Stack className="flex-1 overflow-y-auto px-8 pb-8">`
- **行 60**: 检测到类名 `py-16`
  代码：`<Stack align="center" justify="center" className="py-16 text-text-muted">`
- **行 61**: 检测到类名 `w-12, h-12`
  代码：`<IconTrash className="w-12 h-12 mb-4 opacity-20" />`
- **行 68**: 检测到类名 `px-1`
  代码：`<Flex align="center" gap={2} className="text-[13px] font-semibold text-text-muted px-1">`
- **行 69**: 检测到类名 `w-4, h-4`
  代码：`<IconFolder className="w-4 h-4 opacity-70" />`

---

## 📄 [pages\HomePage.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/pages/HomePage.tsx)

### 🚫 耦合的 Tailwind 样式名 (12 处)
- **行 27**: 检测到类名 `flex`
  代码：`<Flex align="center" justify="center" className="flex-1 w-full h-full">`
- **行 29**: 检测到类名 `text-gray-800`
  代码：`<h1 className="text-[28px] text-gray-800 font-normal tracking-wide">`
- **行 32**: 检测到类名 `text-gray-400`
  代码：`<p className="text-gray-400 text-[15px] mt-3">{getGreeting()}</p>`
- **行 39**: 检测到类名 `flex`
  代码：`<Flex direction="col" align="center" justify="center" className="flex-1 w-full h-full">`
- **行 41**: 检测到类名 `text-gray-800`
  代码：`<h1 className="text-[28px] text-gray-800 font-normal tracking-wide mb-8">`
- **行 47**: 检测到类名 `text-gray-400`
  代码：`<h2 className="text-sm text-gray-400 font-medium mb-3 pl-2">最近打开的项目</h2>`
- **行 54**: 检测到类名 `px-4, py-3, bg-gray-50`
  代码：`className={`px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors ${idx !== recentProjects.length - 1 ? 'border-b border-gray-100' : ''}`}`
- **行 57**: 检测到类名 `text-blue-500`
  代码：`<span className="text-blue-500"><IconFolder /></span>`
- **行 58**: 检测到类名 `w-0`
  代码：`<Stack className="min-w-0">`
- **行 59**: 检测到类名 `text-gray-800`
  代码：`<span className="text-[14px] text-gray-800 font-medium truncate">{proj.name}</span>`
- **行 60**: 检测到类名 `text-gray-400`
  代码：`<span className="text-[12px] text-gray-400 truncate mt-0.5">{proj.rootPath}</span>`
- **行 67**: 检测到类名 `text-gray-400`
  代码：`<p className="text-gray-400 text-[15px] mt-3">{getGreeting()}</p>`

---

## 📄 [pages\SettingsPage.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/pages/SettingsPage.tsx)

### 🚫 耦合的 Tailwind 样式名 (12 处)
- **行 64**: 检测到类名 `flex`
  代码：`<Flex className="flex-1 overflow-hidden">`
- **行 67**: 检测到类名 `p-6`
  代码：`<div className="p-6 pb-4">`
- **行 72**: 检测到类名 `flex, px-4`
  代码：`<Stack className="flex-1 overflow-y-auto px-4 pb-4">`
- **行 73**: 检测到类名 `px-2`
  代码：`<div className="text-[11px] text-text-muted font-medium mb-3 px-2">自定义供应商</div>`
- **行 92**: 检测到类名 `w-0`
  代码：`<Flex align="center" gap={2.5} className="min-w-0">`
- **行 94**: 检测到类名 `w-3, h-3`
  代码：`<IconServer className="w-3.5 h-3.5"/>`
- **行 99**: 检测到类名 `w-1, h-1, rounded-full, bg-green-500`
  代码：`<div className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0 ml-2"></div>`
- **行 159**: 检测到类名 `flex`
  代码：`<Flex align="center" justify="center" className="flex-1 bg-bg-panel text-text-muted text-sm border-l border-border">`
- **行 174**: 检测到类名 `flex, p-8`
  代码：`<Stack align="center" justify="center" className="flex-1 bg-bg-panel text-text-muted text-sm text-center p-8 border-l border-border" gap={2}>`
- **行 175**: 检测到类名 `w-16, h-16`
  代码：`<Flex align="center" justify="center" className="w-16 h-16 mb-4 text-text-light opacity-50">`
- **行 191**: 检测到类名 `p-5`
  代码：`<div className="p-5 pb-3">`
- **行 204**: 检测到类名 `flex, px-3, py-2`
  代码：`<Stack className="flex-1 overflow-y-auto px-3 py-2" gap="4px">`

---

## 📄 [pages\WelcomePage.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/pages/WelcomePage.tsx)

### 🚫 耦合的 Tailwind 样式名 (4 处)
- **行 78**: 检测到类名 `py-2, rounded-lg`
  代码：`<Button variant="primary" size="none" className="btn-primary w-full py-2.5 rounded-lg" onClick={handleOpenProject}>`
- **行 91**: 检测到类名 `p-2, rounded-md, bg-gray-100, flex, items-start`
  代码：`className="recent-link w-full text-left p-2 rounded-md hover:bg-gray-100 flex flex-col items-start"`
- **行 95**: 检测到类名 `text-gray-400`
  代码：`<span className="recent-path text-xs text-gray-400 truncate w-full">{p.rootPath}</span>`
- **行 103**: 检测到类名 `text-gray-400`
  代码：`<p className="welcome-footer text-xs text-gray-400 mt-4">Electron + TypeScript + React</p>`

---

