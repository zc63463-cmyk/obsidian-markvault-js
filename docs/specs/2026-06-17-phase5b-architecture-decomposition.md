# Phase 5B 架构拆分 — 深度任务规划

> 审查完成后的架构拆分方案，目标：3 个巨型文件 → 12 个职责单一的文件
> 前置：Phase 5A P0 修复已完成 (commit 91e8cbd)

---

## 1. 风险分析

架构拆分是高风险操作，主要风险：

| 风险 | 影响 | 缓解策略 |
|------|------|----------|
| **循环依赖** | 运行时崩溃或 esbuild 报错 | 每个文件拆出后立即 `npx tsx --test` + `node esbuild.config.mjs` |
| **模块级闭包状态丢失** | filePathResolver / annotationClickHandler 等全局闭包在新文件中不可见 | 集中到 `editor-view-manager.ts`，统一导出 setter/getter |
| **import 路径错误** | 编译失败 | 每步只拆一个文件，验证后才拆下一个 |
| **CM6 ViewPlugin 内部引用断裂** | Widget 类引用外部函数/缓存，拆分后 this 指向或闭包失效 | Widget 和 PluginValue 保持在同一文件，只拆出缓存/工具函数 |
| **reading-processor 的 this 链** | 20+ private 方法通过 this 互调，拆分后需要桥接 | 按功能域拆分子模块，主类组合调用 |

---

## 2. highlight-applier.ts (1436 行 → 4 文件)

### 2.1 当前结构

```
行 1-47:    import + regionCacheUpdatedEffect
行 48-102:  全局闭包状态 (activeEditorViews Set, filePathResolver, annotationClickHandler)
行 103-166: 工具函数 (getFilePathFromView, resolveFilePath)
行 167-175: 正则常量 (MARK_FULL_REGEX, ATTR_EXTRACT_REGEX, BLOCK_ANCHOR_REGEX)
行 176-286: 三组缓存 (spanCache/regionCache/blockCache + 接口 + CRUD)
行 287-455: 7 个 Widget 类 (MarkOpen/Close, BlockAnchor, NativeAnchor, BlockBadge, RegionAnchorMarker)
行 456-1347: MarkVaultDecorator (PluginValue) — buildDecorationsInner 核心 800 行
  ├─ 456-515:   constructor/update/destroy
  ├─ 516-530:   buildDecorations (try-catch wrapper)
  ├─ 530-1000:  buildDecorationsInner (470 行！)
  │   ├─ viewport 计算
  │   ├─ fenced range 预扫描
  │   ├─ span 装饰构建 (from cache)
  │   ├─ block 装饰构建 (from cache + anchor parsing)
  │   └─ region 装饰构建 (from cache + segment computation)
  ├─ 1000-1060:  computeRegionSegments()
  ├─ 1060-1118:  findRegionBlockLines() (已优化)
  ├─ 1119-1177:  filterOverlapping()
  ├─ 1177-1260:  parseMarkTags()
  ├─ 1260-1310:  computeFencedRanges()
  └─ 1310-1347:  工具方法 (isInFencedRange, parseAttributes, getStyleForType)
行 1348-1406: Plugin Spec + Region Layer Extension + 导出
行 1407-1470: applyReadingModeHighlights + applyStyleToElement
```

### 2.2 拆分方案

#### 文件 A: `src/core/annotation-cache.ts` (~120 行)
**职责**: 三组缓存的接口定义 + CRUD 操作

导出：
- `SpanAnnotationData` 接口
- `RegionAnnotationData` 接口
- `BlockAnnotationData` 接口
- `updateSpanCacheForFile`, `getSpanCacheForFile`, `clearSpanCacheForFile`, `clearSpanCache`
- `updateRegionCacheForFile`, `getRegionCacheForFile`, `clearRegionCacheForFile`, `clearRegionCache`
- `updateBlockCacheForFile`, `getBlockCacheForFile`, `clearBlockCacheForFile`, `clearBlockCache`

依赖：仅 `../types/annotation`

**风险**: 低。纯数据操作，无闭包依赖。

#### 文件 B: `src/core/editor-view-manager.ts` (~85 行)
**职责**: 全局 EditorView 追踪 + 文件路径解析 + 点击回调注入

导出：
- `regionCacheUpdatedEffect` (StateEffect)
- `setActiveEditorView`, `removeEditorView`, `clearActiveEditorViews`
- `requestRegionLayerRedraw`
- `setFilePathResolver`, `resolveFilePath` (改为 export)
- `setAnnotationClickHandler`, `getAnnotationClickHandler` (新增 getter)
- `getFilePathFromView` (改为 export)

依赖：`@codemirror/state`, `@codemirror/view`

**风险**: 低。闭包集中管理，其他文件通过 import 引用。

#### 文件 C: `src/core/highlight-widgets.ts` (~180 行)
**职责**: 7 个 Widget 类定义

导出：
- `MarkOpenWidget`
- `MarkCloseWidget`
- `BlockAnchorWidget`
- `NativeAnchorWidget`
- `BlockBadgeWidget`
- `RegionAnchorMarkerWidget`

依赖：`@codemirror/view`, `../types/annotation`, `./editor-view-manager` (getAnnotationClickHandler — 仅 MarkOpenWidget.ignoreEvent 需要)

**风险**: 中。Widget 的 `ignoreEvent()` 需要 `annotationClickHandler`，改为从 `editor-view-manager` 的 getter 获取。

#### 文件 D: `src/core/highlight-applier.ts` (~950 行)
**职责**: ViewPlugin 实现 + Region Layer + 阅读模式渲染

保留：
- `MarkVaultDecorator` class (PluginValue)
- `markvaultPluginSpec`
- `regionLayerExtension`
- `markvaultDecorationPlugin`, `markvaultRegionLayer`
- `applyReadingModeHighlights`, `applyStyleToElement`
- 私有方法：buildDecorationsInner, computeRegionSegments, filterOverlapping, parseMarkTags, computeFencedRanges, findRegionBlockLines 等

导入：
- 从 `./annotation-cache` 导入缓存接口
- 从 `./editor-view-manager` 导入 resolveFilePath, getFilePathFromView, regionCacheUpdatedEffect
- 从 `./highlight-widgets` 导入 Widget 类

**风险**: 中。需确保 `buildDecorationsInner` 中的所有缓存调用和 Widget 实例化路径正确。

### 2.3 拆分顺序

```
Step 1: 创建 annotation-cache.ts (零依赖的纯数据层)
  → 验证：esbuild 构建 + 全量测试

Step 2: 创建 editor-view-manager.ts (闭包状态集中)
  → 验证：esbuild 构建 + 全量测试

Step 3: 创建 highlight-widgets.ts (Widget 类)
  → 验证：esbuild 构建 + 全量测试

Step 4: 精简 highlight-applier.ts (改为从新文件 import)
  → 验证：esbuild 构建 + 全量测试

Step 5: 更新外部 import (main.ts, cache-manager.ts, sync-engine.ts, reading-processor.ts)
  → 验证：esbuild 构建 + 全量测试
```

### 2.4 外部 import 更新映射

| 消费者 | 原路径 | 需要的符号 | 新路径 |
|--------|--------|-----------|--------|
| main.ts:39 | highlight-applier | setActiveEditorView, removeEditorView, clearActiveEditorViews, setFilePathResolver, setAnnotationClickHandler | editor-view-manager |
| main.ts:39 | highlight-applier | requestRegionLayerRedraw | editor-view-manager |
| main.ts:39 | highlight-applier | markvaultDecorationPlugin, markvaultRegionLayer | highlight-applier (保留) |
| main.ts:52 | highlight-applier | updateSpanCacheForFile, clearSpanCacheForFile, SpanAnnotationData, updateRegionCacheForFile, clearRegionCacheForFile, RegionAnnotationData, getRegionCacheForFile, updateBlockCacheForFile, clearBlockCacheForFile, BlockAnnotationData, getBlockCacheForFile | annotation-cache |
| sync-engine.ts:33 | highlight-applier | setActiveEditorView, requestRegionLayerRedraw | editor-view-manager |
| sync-engine.ts:33 | highlight-applier | clearSpanCacheForFile | annotation-cache |
| cache-manager.ts:24 | highlight-applier | updateSpanCacheForFile, clearSpanCacheForFile, SpanAnnotationData, updateRegionCacheForFile, clearRegionCacheForFile, RegionAnnotationData, getRegionCacheForFile, updateBlockCacheForFile, clearBlockCacheForFile, BlockAnnotationData, getBlockCacheForFile, requestRegionLayerRedraw | annotation-cache + editor-view-manager |
| reading-processor.ts:6 | highlight-applier | requestRegionLayerRedraw | editor-view-manager |

---

## 3. reading-processor.ts (1755 行 → 4 文件)

### 3.1 当前结构

```
行 1-37:    import + ReadingHost 接口
行 38-155:  ReadingModeProcessor 主体
  ├─ constructor
  ├─ registerPostProcessor (行 48-112) — 调度 4 个 process 方法
  ├─ setupReadingModeUI
  ├─ destroy
  ├─ handleDocChange / flushPendingChanges
  ├─ scheduleReadingRefresh / handleReadingRefresh
  ├─ _getCachedRegions (P0-2 缓存)
  ├─ updateReadingToolbar
  ├─ processReadingModeAnnotations (行 162-227)
  行 228-369:  processBlockAnchors — 142 行
  行 370-419:  applyBlockDecoration — 50 行
  行 420-576:  applyBlockDecorationsFromSource — 157 行
  行 577-625:  collectLeafBlocks + computeBlockStarts — 49 行
  行 626-741:  collectLeafBlocks / computeBlockStarts 详细实现
  行 742-784:  processNativeAnnotations — 43 行
  行 784-886:  processRegionAnnotations — 103 行
  行 887-951:  highlightRegionBlocks — 65 行
  行 952-970:  findNearestBlockAncestor — 19 行
  行 971-1007: hideLeakedAnchorText — 37 行
  行 1008-1084: extractInlineRegionAnchors — 77 行
  行 1085-1162: applyRegionStyleToSection — 78 行
  行 1163-1201: styleRegionBlockBorderAndText — 39 行
  行 1202-1222: normalizeRegionMatchText / tokenizeRegionMatchText — 21 行
  行 1222-1327: applyRegionStyleToSectionPrecise — 106 行
  行 1328-1397: wrapTextRange + styleRegionBlockAncestor + addRegionBadge — 70 行
  行 1398-1501: findFirstRegionElement + highlightRegionFromStart + highlightRegionToEnd + applyRegionStyleToNodes — 104 行
  行 1502-1587: applyRegionStyleFromStartAnchor + applyRegionStyleToEndAnchor + applyRegionStyleToMiddleSection — 86 行
  行 1588-1625: applyRegionStyleToMiddleSection (续)
  行 1626-1656: highlightSpanFragments — 31 行
  行 1657-1724: wrapTextFragments — 68 行
  行 1725-1755: findNextContentElement — 31 行
```

### 3.2 拆分方案

#### 文件 A: `src/plugin/reading-block-processor.ts` (~350 行)
**职责**: Block/Span 锚点的阅读模式渲染

包含方法 (从 ReadingModeProcessor 提取为独立函数)：
- `processBlockAnchors` → `processBlockAnchors(el, ctx, plugin)` 
- `applyBlockDecoration`
- `applyBlockDecorationsFromSource`
- `collectLeafBlocks`
- `computeBlockStarts`
- `highlightSpanFragments`
- `wrapTextFragments`
- `findNextContentElement`

依赖：`annotationStore`, `annotation-parser`, `block-fingerprint`, `md-context`, `../types/annotation`

**风险**: 中。方法之间通过参数传递而非 this，需要设计清晰的接口。

#### 文件 B: `src/plugin/reading-region-processor.ts` (~600 行)
**职责**: Region 标注的阅读模式渲染 (reading-processor 中最大的一块)

包含方法：
- `processRegionAnnotations`
- `highlightRegionBlocks`
- `findNearestBlockAncestor`
- `hideLeakedAnchorText`
- `extractInlineRegionAnchors` + `extractInlineRegionAnchorsFromTextNode`
- `applyRegionStyleToSection`
- `styleRegionBlockBorderAndText`
- `normalizeRegionMatchText` / `tokenizeRegionMatchText`
- `applyRegionStyleToSectionPrecise`
- `wrapTextRange`
- `styleRegionBlockAncestor`
- `addRegionBadge`
- `findFirstRegionElement` + `highlightRegionFromStart` + `highlightRegionToEnd`
- `applyRegionStyleToNodes`
- `applyRegionStyleFromStartAnchor` + `applyRegionStyleToEndAnchor` + `applyRegionStyleToMiddleSection`

依赖：`region-annotation`, `annotationStore`, `../types/annotation`

**风险**: 高。region 渲染方法间有大量 this 互调，需要统一为模块级函数 + 传参。

#### 文件 C: `src/plugin/reading-native-processor.ts` (~50 行)
**职责**: 自然语法标注的阅读模式渲染

包含方法：
- `processNativeAnnotations`

依赖：`native-annotation`, `annotationStore`, `../types/annotation`

**风险**: 低。方法简短，无 this 互调。

#### 文件 D: `src/plugin/reading-processor.ts` (~200 行)
**职责**: 主类，组合调用三个子处理器

保留：
- `ReadingHost` 接口
- `ReadingModeProcessor` class (精简版)
  - constructor
  - registerPostProcessor (调度)
  - setupReadingModeUI
  - destroy
  - handleDocChange / flushPendingChanges
  - scheduleReadingRefresh / handleReadingRefresh
  - _getCachedRegions
  - updateReadingToolbar
  - processReadingModeAnnotations (精简，委托到子模块)
  - hideLeakedAnchorText (保留在主类，因为它是防御性清理)

导入：
- `processBlockAnchors` from `./reading-block-processor`
- `processRegionAnnotations` from `./reading-region-processor`
- `processNativeAnnotations` from `./reading-native-processor`

### 3.3 拆分顺序

```
Step 1: 提取 reading-native-processor.ts (最简单，43 行)
  → 验证：esbuild + 测试

Step 2: 提取 reading-block-processor.ts (中等复杂度)
  → 验证：esbuild + 测试

Step 3: 提取 reading-region-processor.ts (最复杂，600 行)
  → this 互调全部改为函数参数传递
  → 验证：esbuild + 测试

Step 4: 精简 reading-processor.ts 主类
  → 组合调用三个子模块
  → 验证：esbuild + 测试
```

### 3.4 this 互调转换策略

reading-processor 中最大的难点是 20+ private 方法通过 `this.xxx()` 互调。
拆分策略：

**方案 A (推荐): 函数式提取**
- 每个 private 方法转为独立导出函数
- 原来的 `this.xxx()` 调用改为 `xxx()` 函数调用
- 原来依赖 `this.plugin` 的地方改为显式传参

```typescript
// Before (in class):
private async processBlockAnchors(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
  const sourcePath = ctx.sourcePath;
  // ... uses this.plugin, this.applyBlockDecoration, etc.
}

// After (extracted function):
export async function processBlockAnchors(el: HTMLElement, ctx: MarkdownPostProcessorContext, plugin: ReadingHost): Promise<void> {
  const sourcePath = ctx.sourcePath;
  // ... uses plugin directly, calls applyBlockDecoration() directly
}
```

**方案 B: 子类组合 (不推荐)**
- 创建 BaseProcessor / BlockProcessor / RegionProcessor 子类
- 问题：JavaScript 继承链复杂，不利于 tree-shaking

---

## 4. annotation-parser.ts (1205 行 → 3 文件)

### 4.1 当前结构

```
行 1-33:    import + FormatRegistry 注入
行 34-198:  Track A: 行内 <mark> 标注 (parse/build/remove/update) — 165 行
行 199-428: Track A 工具函数 (parseHighlightr, parsePlainMark, parseMarkAttributes, escapeAttr, escapeRegex) — 230 行
行 429-508: Track B: 块级/span 单锚点 (build/remove/update) — 80 行
行 509-655: Track B-v2: Block 双锚点 (build/parse/range) — 147 行
行 656-948: Track B 工具函数 (findBlockContentEndLine, parseBlockAnchors, removeBlock/Span/AnyAnchor, updateBlock/Span/AnyAnchor, findBlockTargetLine) — 293 行
行 975-1146: parseAllAnnotationsFromMarkdown (统一入口) — 172 行
行 1147-1205: findSpanEndLine + computeSpanRanges — 59 行
```

### 4.2 拆分方案

#### 文件 A: `src/core/inline-annotation-parser.ts` (~400 行)
**职责**: Track A — 行内 `<mark>` 标注的解析/构建/删除/更新

导出：
- `parseAnnotationsFromMarkdown`
- `parseMarkVaultAnnotations`
- `parseHighlightrAnnotations`
- `parsePlainMarkAnnotations`
- `parseMarkAttributes`
- `buildMarkTag`
- `removeMarkTag`
- `updateMarkTag`
- `decodeHTMLEntities`
- `escapeAttr`
- `escapeRegex`

依赖：`../types/annotation`, `./native-annotation`

**风险**: 低。功能内聚，外部接口清晰。

#### 文件 B: `src/core/block-annotation-parser.ts` (~520 行)
**职责**: Track B — 块级/span/block双锚点标注

导出：
- `parseBlockAnchors`, `ParsedBlockAnchor`
- `parseBlockDoubleAnchors`, `ParsedBlockDoubleAnchor`, `BLOCK_DOUBLE_ANCHOR_REGEX`
- `findBlockDoubleAnchorRange`, `BlockDoubleAnchorRange`
- `buildBlockAnchor`, `buildSpanAnchor`
- `buildBlockAnchorStart`, `buildBlockAnchorEnd`
- `findBlockTargetLine`, `findBlockContentEndLine`, `findSpanEndLine`
- `removeBlockAnchor`, `removeSpanAnchor`, `removeAnyAnchor`
- `updateBlockAnchor`, `updateSpanAnchor`, `updateAnyAnchor`
- `computeSpanRanges`
- `escapeAnchorField`, `decodeAnchorField` (从 private 改为 export)
- `escapeBlockAnchorField`, `decodeBlockAnchorField` (同上)

依赖：`../types/annotation`, `./block-fingerprint`, `./region-annotation`

**风险**: 中。部分工具函数从 private 改为 export，需要确认无命名冲突（escapeAnchorField 在 region-annotation.ts 也有同名函数）。

#### 文件 C: `src/core/annotation-parser.ts` (~200 行)
**职责**: 统一解析入口 + FormatRegistry 桥接

保留：
- `injectFormatRegistry`, `getFormatRegistry`
- `parseAllAnnotationsFromMarkdown` (调用 A + B + region + native)

导入：
- `parseAnnotationsFromMarkdown`, `buildMarkTag`, `removeMarkTag`, `updateMarkTag` from `./inline-annotation-parser`
- `parseBlockAnchors`, `parseBlockDoubleAnchors`, `findBlockTargetLine`, `findBlockContentEndLine`, `findSpanEndLine`, `computeSpanRanges`, `removeBlockAnchor`, `removeSpanAnchor`, `removeAnyAnchor`, `updateBlockAnchor`, `updateSpanAnchor`, `updateAnyAnchor`, `buildBlockAnchor`, `buildSpanAnchor`, `buildBlockAnchorStart`, `buildBlockAnchorEnd`, `BLOCK_DOUBLE_ANCHOR_REGEX` from `./block-annotation-parser`
- `parseRegionAnnotations` from `./region-annotation` (保持不变)
- `parseNativeAnnotations` from `./native-annotation` (保持不变)

**转发表**: 所有从 A/B 导入的符号通过 annotation-parser.ts 重新导出（`export { ... } from './inline-annotation-parser'`），确保外部消费者的 import 无需修改。

**风险**: 低。纯转发层，外部零改动。

### 4.3 拆分顺序

```
Step 1: 创建 inline-annotation-parser.ts
  → 从 annotation-parser.ts 剪切 Track A 代码
  → 在 annotation-parser.ts 中添加 re-export
  → 验证：esbuild + 测试

Step 2: 创建 block-annotation-parser.ts
  → 从 annotation-parser.ts 剪切 Track B 代码
  → 在 annotation-parser.ts 中添加 re-export
  → 验证：esbuild + 测试

Step 3: 精简 annotation-parser.ts 为转发层 + parseAllAnnotationsFromMarkdown
  → 验证：esbuild + 测试
```

---

## 5. 执行时间线与检查点

```
Day 1: highlight-applier.ts 拆分 (5 steps)
  - 每个 step 后: esbuild 构建 + 541 测试
  - 最终检查: Obsidian 手动加载验证

Day 2: reading-processor.ts 拆分 (4 steps)
  - 每个 step 后: esbuild 构建 + 541 测试
  - 重点: reading-region-processor.ts 的 this 互调转换

Day 3: annotation-parser.ts 拆分 (3 steps)
  - 每个 step 后: esbuild 构建 + 541 测试
  - 重点: re-export 层确保外部零改动

Day 3 下午: 全量回归验证
  - esbuild production 构建
  - 541 测试全量通过
  - Obsidian 手动验证 (创建/编辑/删除标注 + 阅读模式)
  - 部署到 E:\Notes\数据库系统概论\.obsidian\plugins\markvault-js\
```

---

## 6. 验证检查清单

每个 step 必须通过：

- [ ] `node esbuild.config.mjs production` — 构建成功
- [ ] `npx tsx --test tests/*.test.ts` — 541 测试全绿
- [ ] 无循环依赖警告
- [ ] main.js 体积无明显增长 (<5% 膨胀)

最终检查：

- [ ] 三个巨型文件行数: highlight-applier < 1000, reading-processor < 300, annotation-parser < 250
- [ ] 所有新增文件有清晰的模块注释
- [ ] 无 duplicate function name 警告
- [ ] Obsidian 手动加载验证通过

---

## 7. 不拆的部分

以下文件虽然也较大，但 **不在 Phase 5B 范围内**：

- `context-menu.ts` (1074 行) — 功能内聚（右键菜单），拆分收益低
- `AnnotationSidebar.ts` (767 行) — Phase 5D 再考虑
- `RelationGraphView.ts` (1208 行) — Phase 5D 再考虑
- `annotation-modal.ts` — UI 组件，拆分策略不同

---

## 8. 回滚策略

每个 step 前创建 git commit。如果某 step 失败：

1. `git stash` 当前未提交的修改
2. `git reset --hard HEAD` 回到上一个好的 commit
3. 分析失败原因，修改拆分方案后重试

**绝对不要**在失败的 step 上继续叠加修改——那样会制造难以追踪的级联错误。
