# MarkVault-JS v3.0 — 标注功能汇报

> 生成时间：2026-06-14 | 状态：开发中，已部署测试

---

## 一、项目概述

**MarkVault-JS** 是 Obsidian 的增强标注插件，提供 **5 种标注类型**，覆盖从行内文本到跨段落区域的完整标注场景。支持编辑/阅读双模式渲染、侧边栏管理、批注编辑、颜色切换等全流程。

```
版本：3.0.0（Phase 2 — 分片 JSON 存储，已移除 IndexedDB）
作者：Jiang
技术栈：TypeScript + Obsidian API + CM6 Decoration + esbuild
```

---

## 二、标注类型总览

| 类型 | kind | 锚点格式 | 触发方式 | 覆盖场景 |
|------|------|---------|---------|---------|
| **Inline** | `inline` | `<mark data-uuid="xxx" data-type="..." data-color="...">text</mark>` | 选中文本 → 标注 | 纯文本行内标注 |
| **Native** | `inline` | `<!--mv:i:uuid:type:color:note-->**text**<!--/mv:i:uuid-->` | 选中文本 → 标注 | 粗体/下划线原生化 |
| **Block** | `block` | `%%markvault-block:uuid:type:color:start%%` … `%%markvault-block:uuid:type:color:end%%` | 光标在块内 → 标注整块 | 段落/列表项/公式块/代码块 |
| **Span** | `span` | 复用 Block 双锚点 + `spanRanges` 记录片段范围 | 选中文本 → 标注 | 跨行精确选中 |
| **Region** | `region` | `%%markvault-region:uuid:type:color:start:note%%` … `%%markvault-region:uuid:type:color:end:note%%` | 选中文本 → 整行背景渲染 | 含公式/代码/图片的复杂选区 |

### 标注样式（3 种类型）

| 类型 | 编辑模式 | 阅读模式 |
|------|---------|---------|
| **Highlight** | 半透明色块背景 | 段落级背景色 |
| **Bold** | 色块背景 + 加粗字体 | 段落级淡色背景 |
| **Underline** | 色块背景 + 底部边框 | 段落级虚线底部边框 |

### 颜色体系（5 色）

| 颜色 | 色值 | CSS 变量 |
|------|------|---------|
| Yellow | `#FACC15` | `markvault-region-yellow` |
| Green | `#4ADE80` | `markvault-region-green` |
| Blue | `#60A5FA` | `markvault-region-blue` |
| Pink | `#F472B6` | `markvault-region-pink` |
| Purple | `#C084FC` | `markvault-region-purple` |

---

## 三、操作方式

### 3.1 编辑模式

#### 右键菜单
| 菜单项 | 功能 | 触发条件 |
|--------|------|---------|
| 🎨 Highlight | Inline highlight 标注 | 有选中文本 |
| 𝗕 Bold | Inline bold 标注 | 有选中文本 |
| U̲ Underline | Inline underline 标注 | 有选中文本 |
| ▭ Region | Region 双锚点标注 | 有选中文本（自动判断是否需要 region） |
| ▦ Annotate block | Block 双锚点标注 | 光标在块内（段落/列表/公式/代码块/图片） |
| 📝 Annotate + Note | 标注并添加批注 | 有选中文本 |

#### 命令面板（Ctrl+P）
| 命令 ID | 名称 |
|--------|------|
| `annotate-highlight` | Highlight selection |
| `annotate-bold` | Bold selection |
| `annotate-underline` | Underline selection |
| `annotate-highlight-yellow/green/blue/pink/purple` | Highlight (指定颜色) |
| `annotate-with-note` | Annotate and add note |
| `annotate-block` | Annotate current block |
| `markvault-force-sync` | Force sync current file |
| `markvault-rebuild-db` | Rebuild annotation database |
| `markvault-clean-orphans` | Clean orphan annotations |

### 3.2 阅读模式

#### 浮动工具条
选中文本后，自动弹出浮动工具条，包含：

| 按钮 | 功能 |
|------|------|
| 🎨 | Highlight |
| 𝗕 | Bold |
| U̲ | Underline |
| ▭ | Region |
| 📝 | Annotate + Note |

#### 右键菜单
| 菜单项 | 功能 |
|--------|------|
| 🎨 Highlight | Inline highlight |
| 𝗕 Bold | Inline bold |
| U̲ Underline | Inline underline |
| ▭ Region | Region 双锚点 |
| 🎨 Highlight (指定颜色) | 选择颜色标注 |
| 📝 Annotate + Note | 标注并添加批注 |

#### 交互行为
| 操作 | 响应 |
|------|------|
| 点击标注区域 | 打开标注编辑 Modal（可修改颜色/类型/批注/标签） |
| 侧边栏点击标注项 | 跳转到对应笔记并高亮定位 |
| 侧边栏筛选 | 按类型/颜色/搜索文本过滤 |

---

## 四、底层实现架构

### 4.1 存储层（Phase 2 — 分片 JSON）

```
.obsidian/plugins/markvault-js/annotations/
├── _index.json           # 全局索引（filePath → shardFile → annotation UUIDs）
├── _meta.json            # 元数据
└── <base64-encoded-path>.json  # 每文件一个分片
```

**Annotation 数据结构：**
```typescript
interface Annotation {
  uuid: string;           // 全局唯一标识
  filePath: string;        // 所在笔记路径
  type: 'highlight' | 'bold' | 'underline';  // 标注样式
  color: 'yellow' | 'green' | 'blue' | 'pink' | 'purple';
  text: string;            // 标注文本内容
  note: string;            // 批注内容
  tags: string[];          // 标签
  kind: 'inline' | 'block' | 'span' | 'region';  // 标注种类
  startOffset: number;     // 源码起始偏移
  endOffset: number;       // 源码结束偏移
  startLine: number;       // 起始行号
  endLine: number;         // 结束行号
  createdAt: number;
  updatedAt: number;
  // Block/Span 特有
  targetLine?: number;
  anchorLine?: number;
  spanRanges?: SpanRange[];
  // Region 特有
  contextBefore?: string;
  contextAfter?: string;
}
```

### 4.2 编辑模式渲染（CM6 Decoration）

```
Markdown 源码：  <mark data-uuid="x" data-type="highlight" data-color="yellow">文本</mark>

CM6 渲染引擎：
┌──────┬──────────┐
│ 隐   │ Decor    │ 隐   │
│ 藏   │ ation    │ 藏   │
│ 开   │ (背景色   │ 闭   │
│ 标   │ +样式)    │ 标   │
│ 签   │          │ 签   │
└──────┴──────────┘
  Widget   Mark     Widget
  replace  deco     replace
  
用户看到：  [带背景色的文本]
```

**核心文件：** `src/core/highlight-applier.ts`
- `MarkVaultDecorator` — CM6 ViewPlugin，管理所有标注的 Decoration
- `cache` — 按 filePath 缓存 Decoration Set
- 增量更新：仅在 docChanged 时重新计算受影响范围

**Region 编辑模式：**
- `regionLayerExtension` — CM6 `layer`，按 `regionCache` 绘制半透明背景矩形
- 锚点行通过 `Decoration.replace` 隐藏
- `regionCache` 在文件打开/切换时异步刷新

### 4.3 阅读模式渲染（MarkdownPostProcessor）

```
Obsidian 渲染管线：
  Raw Markdown → MarkdownPostProcessor → 带标注样式的 HTML

执行顺序（每个 section）：
  1. processNativeAnnotations  — 自然语法标注（隐身锚点）
  2. processBlockAnchors       — Block/Span 双锚点
  3. processRegionAnnotations  — Region 双锚点（Block 架构）
  4. hideLeakedAnchorText      — 清理泄漏锚点
```

**Block 渲染流程（`applyBlockDecorationsFromSource`）：**
```
源码解析双锚点
  → parseBlockDoubleAnchors(content)
  → 行号范围计算 (findBlockTargetLine / findBlockContentEndLine)
  → collectLeafBlocks(el)    ← 收集渲染后的叶子块元素
  → computeBlockStarts()     ← 行号 → 叶子块索引映射
  → 行号范围匹配 → 叶子块染色
  → 添加徽章/批注指示器
```

**Region 渲染流程（`processRegionAnnotations` — v3.0 重写）：**
```
源码解析双锚点
  → parseRegionAnnotations(content)  ← 支持内联锚点、全文件搜索
  → collectLeafBlocks(el)            ← 复用 Block 基础设施
  → computeBlockStarts()             ← 复用 Block 基础设施
  → 行号范围匹配 → 叶子块染色
  → 补充锚点行到 blockStarts        ← 处理行首 %%... 锚点
  → Callout 偏移修正                ← > 开头行向上偏移一行
  → 应用 markvault-region-block-mark + 首/尾 ▸/◂ 标记
  → 添加徽章/批注指示器
```

### 4.4 点击委托（ReadingModeClickDelegate）

阅读模式下，全局 `capture` 阶段监听 `click` 事件，按优先级检测：

```
优先级 1: <mark data-uuid>                    → Inline 标注
优先级 2: .markvault-block-mark[data-uuid]     → Block 标注
优先级 3: [data-kind="span"][data-uuid]       → Span 标注
优先级 4: .markvault-native[data-uuid]         → Native 标注
优先级 5: .markvault-region-block-mark[data-uuid] → Region 标注（新）
优先级 6: .markvault-region[data-uuid]         → Region 标注（旧，向后兼容）

找到后 → e.stopImmediatePropagation() → 打开 AnnotationModal
CM6 编辑区域内的点击忽略（由 WidgetType 处理）
```

### 4.5 标注创建流程

**Inline 标注（编辑模式）：**
```
选中文本 → 获取 start/end offset
  → 生成 UUID
  → 构建 <mark data-uuid="..." data-type="..." data-color="...">text</mark>
  → replaceRange 替换选中文本
  → AnnotationStore.addAnnotation() 持久化
  → 刷新 CM6 Decoration 缓存
```

**Block 标注：**
```
获取光标所在行 → 找到所属块
  → 生成双锚点 %%markvault-block:uuid:type:color:start%% / end%%
  → 插入到块前后
  → AnnotationStore.addAnnotation()
  → 刷新缓存
```

**Region 标注：**
```
选中文本 → 判断是否需要 region（内容含公式/代码/跨块等）
  → 生成双锚点 %%markvault-region:uuid:type:color:start:note%% / end:note%%
  → note 字段对 : 和 % 做转义（: → \c, % → \p）
  → 在选区前后插入锚点
  → AnnotationStore 保存
  → 刷新 regionCache
```

### 4.6 文件同步（Force Sync）

```
读取 MD 文件
  → parseAllAnnotationsFromMarkdown(content)  ← 解析所有标注
  → 对比 AnnotationStore 中的数据
  → 新增/更新/删除
  → flushAll() 写回分片
  → cleanOrphanAnnotations() 清理孤儿标注
```

**偏移恢复（Target Hash）：**
- 每个 block/region 标注记录 `targetHash`（目标块内容的哈希）
- sync 时通过哈希匹配恢复位置
- 支持文件编辑后重新定位标注

---

## 五、CSS 样式体系

### 5.1 Region 段落级样式（v3.0 新架构）

```css
.markvault-region-block-mark {
  position: relative;
  border-left: 3px solid var(--mv-region-color);
  border-right: 3px solid var(--mv-region-color);
  border-radius: 0 6px 6px 0;
  transition: all 0.15s ease;
}
.markvault-region-block-mark:hover {
  filter: brightness(1.05);
}
/* 首尾标记 */
.markvault-region-block-first::before { content: "▸"; /* 左三角 */ }
.markvault-region-block-last::after   { content: "◂"; /* 右三角 */ }

/* 5 色 × 3 型 = 15 种视觉变体 */
.markvault-region-block-mark.markvault-region-yellow { --mv-region-color: #FACC15; }
.markvault-region-block-mark.markvault-region-green  { --mv-region-color: #4ADE80; }
/* ... */
.markvault-region-block-mark.markvault-region-highlight { background-color: #FACC151A; }
.markvault-region-block-mark.markvault-region-bold      { background-color: #FACC1515; }
.markvault-region-block-mark.markvault-region-underline { border-bottom: 2px dashed #FACC15; }
```

### 5.2 Block 段落样式

```css
.markvault-block-mark { /* 整块背景 + 左侧色条 */ }
.markvault-block-type-badge { /* 右上角类型徽章 𝗕/U̲/🎨 */ }
.markvault-block-note-indicator { /* 📝 批注指示器 */ }
```

---

## 六、关键文件索引

| 文件 | 职责 |
|------|------|
| `src/main.ts` | 插件入口、post-processor、命令注册、CM6 扩展 |
| `src/core/annotation-store.ts` | 分片 JSON 存储引擎 |
| `src/core/region-annotation.ts` | Region 锚点解析/生成 |
| `src/core/block-annotation.ts` | Block 双锚点解析/生成 |
| `src/core/native-annotation.ts` | 自然语法标注 |
| `src/core/highlight-applier.ts` | CM6 Decoration 管理 |
| `src/ui/reading/ReadingModeClickDelegate.ts` | 阅读模式点击委托 |
| `src/ui/editor/context-menu.ts` | 右键菜单 + 命令注册 |
| `src/ui/editor/annotation-modal.ts` | 标注编辑弹窗 |
| `src/ui/sidebar/AnnotationSidebar.ts` | 侧边栏管理 |
| `styles.css` | 全部视觉样式 |

---

## 七、测试覆盖

| 测试套件 | 测试数 | 状态 |
|---------|--------|------|
| AnnotationStore | 17 | ✅ |
| Native Annotation | 10 | ✅ |
| Region Annotation | 7 | ✅ |
| Block Annotation | 9 | ✅ |
| **总计** | **43** | **✅** |

---

## 八、v3.0 Region 架构重写（2026-06-14）

### 重构动机
- 旧架构：DOM 扫描锚点节点 → 多路径 fallback → 文本级精确包裹
- 新架构：基于 Block 管线 → 源码行号映射 → 段落级背景渲染

### 关键变更
| 项 | 旧 | 新 |
|---|----|----|
| 锚点解析 | DOM Comment/Element/Text walker | `parseRegionAnnotations()` 全文本解析 |
| 块映射 | `highlightRegionBlocks` (TreeWalker) | `collectLeafBlocks` + `computeBlockStarts` (Block 管线) |
| 渲染方式 | 文本级 span 包裹 | 块级背景 + ▸/◂ CSS 伪元素 |
| 点击检测 | `.markvault-region` | `.markvault-region-block-mark` |
| 代码量 | ~250 行 + 10 个辅助方法 | ~105 行核心 + 复用 Block 基础设施 |

### 已知限制
- 同排多 Region 共享同一 leafBlock 时，只有最后一个生效（Block 架构固有限制）
- Callout 内 Region 需要 offset 修正（已处理）

---

## 九、开发指令

```bash
# 位置
cd E:/Development/MyAwesomeApp/markvault-js

# 构建
npm run build          # tsc + esbuild production

# 测试（需 NODE_OPTIONS= 环境变量）
npm test               # 43 项单元测试

# 部署
cp main.js styles.css manifest.json E:/Notes/数据库系统概论/.obsidian/plugins/markvault-js/
```

---

## 十、测试文档

| 文档 | 路径 | 场景数 |
|------|------|--------|
| Region 原始测试 | `docs/MarkVault-Region-Test.md` | 12 |
| Block+Region 混合 | `docs/MarkVault-Block-List-Test.md` | 26 |
| Region 段落级渲染 | `docs/MarkVault-Region-Block-Style-Test.md` | 24 |

---

> 生成时间：2026-06-14 | 本报告基于当前 master 分支最新提交
