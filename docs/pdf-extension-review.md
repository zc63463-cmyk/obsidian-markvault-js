# PDF 扩展审查报告 — 对比 PDF++ 架构

> 审查日期: 2026-06-18 | 审查范围: PDF 扩展 Phase 1 MVP 全部代码
> 参考项目: [PDF++ (ryotaushio/obsidian-pdf-plus)](https://github.com/ryotaushio/obsidian-pdf-plus) — 最成熟的 Obsidian PDF 标注插件

---

## 审查方法

深入研究了 PDF++ 的技术架构（通过官方文档 + CSDN 技术分析 + 源码结构），对比 MarkVault PDF 扩展的实现，按严重程度分级发现 7 个问题。

---

## PDF++ 核心架构对比

| 维度 | PDF++ | MarkVault PDF | 评价 |
|------|-------|---------------|------|
| **API 访问** | `monkey-around` 拦截 `PDFView.prototype` | 鸭子类型 + 多路径防御 | PDF++ 更可靠但侵入性强 |
| **选区拦截** | 拦截 `onTextSelection` 原生事件 | `window.getSelection()` | PDF++ 更早、更精确 |
| **高亮渲染** | CSS div + `data-highlight-color` 属性 | SVG rect | PDF++ 样式更灵活 |
| **坐标存储** | 百分比坐标 `x/width*100` | 绝对 PDF 坐标 | PDF++ 缩放时无需重算 |
| **数据存储** | Markdown 反向链接 `[[file.pdf#page=1&selection=...]]` | Store JSON (非破坏性) | 各有优势，MV 更适合认知系统 |
| **主题适配** | CSS 变量 `--pdf-plus-{color}-rgb` | JS 内联 + CSS 类 | PDF++ 更优雅 |

---

## P0 严重问题（已修复）

### 1. MutationObserver 无限循环
**文件**: `src/pdf/pdf-renderer.ts:424-430`
**问题**: `MutationObserver` 监听 `subtree: true`，回调直接调用 `renderAll()`。而 `renderAll()` → `appendChild(svg)` → 触发 `MutationObserver` → `renderAll()` → **无限循环**。
**修复**: 
- 加 300ms 防抖 timer
- 过滤自身 overlay 变更：检查 `addedNodes` 是否为 `markvault-pdf-overlay` 或 `markvault-pdf-highlight` class

### 2. 坐标转换 Bug
**文件**: `src/pdf/viewer-bridge.ts:369-371`
**问题**: 手动转换中 `pageHeight` 从 `viewport?.height` 获取（PDF 原始尺寸），但 Y 翻转用了 `pageRect.height`（屏幕渲染尺寸 = viewport.height × scale）。缩放时两者不同，导致 **Y 坐标计算错误**。
**修复**: 统一使用 `pageHeight`（viewport.height）。

### 3. scroll handler 内存泄漏
**文件**: `src/pdf/pdf-renderer.ts:436-437`
**问题**: `detachListeners()` 时 `this.container` 已被 `unmount()` 设为 null，`this.container?.closest('.view-content')` 返回 null，`removeEventListener` 无法执行 → **事件监听器泄漏**。
**修复**: 在 `attachListeners()` 时保存 `scrollContainer` 引用到实例属性，`detachListeners()` 使用保存的引用。

---

## P1 重要改进（已修复）

### 4. rAF 防抖
**文件**: `src/pdf/pdf-renderer.ts`
**问题**: scroll/resize 时 `updateOverlayPositions()` 每次都全量重计算所有高亮位置，大量标注时卡顿。
**修复**: 用 `requestAnimationFrame` 合并高频事件，一帧内只执行一次更新。

### 5. 轮询替代硬延迟
**文件**: `src/main.ts:728`
**问题**: `handlePDFOpen` 用 `setTimeout(300)` 等待 PDF.js DOM 渲染。大 PDF 可能需要更久，小 PDF 浪费时间。
**修复**: 用 100ms 间隔轮询检测 `[data-page-number]` 元素出现，最多等待 3 秒。

### 6. 颜色映射复用
**文件**: `src/pdf/pdf-renderer.ts:520-537`
**问题**: `getColorHex()` 硬编码了颜色映射 `Record<string, string>`，与 `types/annotation.ts` 的 `PRESET_COLORS` 重复。
**修复**: 改用 `PRESET_COLORS.find(c => c.id === color)` 复用全局定义。

### 7. PdfFormat 死代码
**文件**: `src/pdf/pdf-format.ts:18`
**问题**: 导入了 `logger` 但从未使用。
**修复**: 移除未使用的导入。

---

## P2 架构建议（后续优化方向）

这些是对比 PDF++ 后发现的架构级优化机会，当前不影响功能，但在 Phase 2+ 可考虑：

### 8. 百分比坐标存储
PDF++ 用 `x/width*100` 百分比坐标存储高亮位置。优势：缩放时只需调整容器尺寸，高亮自动跟随，**不需要重新计算所有 rect 位置**。我们当前每次缩放都全量重算 `updateOverlayPositions()`。

### 9. CSS div 替代 SVG
PDF++ 用 CSS div + `data-highlight-color` 属性渲染高亮。优势：
- `:hover` 效果更容易
- CSS 变量主题适配更优雅
- 不需要 `createElementNS` 
- 性能更好（DOM 操作更少）

### 10. Monkey Patching
PDF++ 用 `around()` 包装 `PDFView.prototype.onTextSelection`，在 Obsidian 选区处理流程中更早拦截。我们用 `window.getSelection()` 是在 DOM 层面获取，可能错过 Obsidian 的内部选区状态。

### 11. textContent 提取
PDF++ 通过 `PDFPage.getTextContent()` 获取精确的文本位置信息，扫描版 PDF 也能工作。我们完全依赖 DOM Selection API，扫描版 PDF 会失效。

---

## 新增 CSS 样式

`styles.css` 追加了 PDF 标注相关样式：

```css
.markvault-pdf-overlay { pointer-events: auto; mix-blend-mode: multiply; }
.markvault-pdf-highlight { cursor: pointer; transition: opacity 0.2s ease; }
.markvault-pdf-highlight:hover { opacity: 0.55 !important; }
.markvault-pdf-highlight-active { animation: markvault-pdf-flash 1.5s ease-in-out; }
@keyframes markvault-pdf-flash { 0%,100% { opacity: 0.35; } 50% { opacity: 0.7; } }
.theme-dark .markvault-pdf-highlight { filter: brightness(1.2); }
```

---

## 验证结果

| 检查项 | 结果 |
|--------|------|
| `tsc -noEmit -skipLibCheck` | ✅ exit 0 |
| `npm test` (20 文件) | ✅ 全绿 |
| `esbuild production` | ✅ exit 0, 零警告 |
