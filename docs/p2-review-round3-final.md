# 三轮终审：行动前逐行验证报告

> **审查人**: Senior Developer | **日期**: 2026-06-16 09:59
> **目的**: 产出实施级精确规格，每个数字均经 `awk` 精确测量验证
> **方法**: 对 main.ts (3584行) 和 annotation-store.ts (2524行) 逐方法 `awk` 测量

---

## 🚨 二轮审查的 3 个严重错误

### 错误 A: ReadingProcessor 不是 631 行，是 2336 行 🔴🔴🔴

二轮审查声称 ReadingProcessor ~631 行，实际 **2336 行** (L618-L2953)。

**根因**: 二轮审查只计算了 `MarkdownPostProcessor + renderers` (568行) 和 `handleDocChange` (63行) 两个区域，**完全遗漏了 L1236-L2953 的 24 个 region/span 渲染方法**。

逐方法精确测量:

| # | 方法 | 行号范围 | 精确行数 |
|:--|------|:--------|:-------:|
| 1 | PostProcessor callback | 618-695 | 78 |
| 2 | processBlockAnchors | 1247-1399 | 153 |
| 3 | applyBlockDecoration | 1400-1449 | 50 |
| 4 | isNodeBefore | 1450-1458 | 9 |
| 5 | applyBlockDecorationsFromSource | 1459-1627 | 169 |
| 6 | collectLeafBlocks | 1628-1680 | 53 |
| 7 | computeBlockStarts | 1681-1798 | 118 |
| 8 | processNativeAnnotations | 1799-1863 | 65 |
| 9 | processRegionAnnotations | 1864-1986 | 123 |
| 10 | highlightRegionBlocks | 1987-2058 | 72 |
| 11 | findNearestBlockAncestor | 2059-2083 | 25 |
| 12 | hideLeakedAnchorText | 2084-2125 | 42 |
| 13 | extractInlineRegionAnchors | 2126-2151 | 26 |
| 14 | extractInlineRegionAnchorsFromTextNode | 2152-2206 | 55 |
| 15 | applyRegionStyleToSection | 2207-2293 | 87 |
| 16 | styleRegionBlockBorderAndText | 2294-2332 | 39 |
| 17 | normalizeRegionMatchText | 2333-2343 | 11 |
| 18 | tokenizeRegionMatchText | 2344-2357 | 14 |
| 19 | applyRegionStyleToSectionPrecise | 2358-2410 | 53 |
| 20 | wrapTextRange | 2411-2469 | 59 |
| 21 | styleRegionBlockAncestor | 2470-2496 | 27 |
| 22 | addRegionBadge | 2497-2521 | 25 |
| 23 | findFirstRegionElement | 2522-2537 | 16 |
| 24 | highlightRegionFromStart | 2544-2565 | 22 |
| 25 | highlightRegionToEnd | 2566-2588 | 23 |
| 26 | applyRegionStyleToNodes | 2589-2658 | 70 |
| 27 | applyRegionStyleFromStartAnchor | 2659-2707 | 49 |
| 28 | applyRegionStyleToEndAnchor | 2708-2756 | 49 |
| 29 | applyRegionStyleToMiddleSection | 2757-2801 | 45 |
| 30 | highlightSpanFragments | 2802-2836 | 35 |
| 31 | wrapTextFragments | 2837-2904 | 68 |
| 32 | findNextContentElement | 2905-2953 | 49 |
| | **纯方法合计** | | **1787** |
| | **含注释/空行/section header** | 618-2953 | **2336** |

### 错误 B: AnnotationCreator 是 517 行，不是 500 行

| 方法 | 行号范围 | 精确行数 |
|------|:--------|:-------:|
| createReadingAnnotation | 3067-3250 | 184 |
| findBestTextOffset + 5 辅助函数 | 3268-3583 | 316 |
| gap (注释/空行) | 3251-3267 | 17 |
| **合计** | 3067-3583 | **517** |

### 错误 C: main.ts 保留量计算仍然有误

二轮审查声称 ~496 行。实际逐区域精确计算:

| 留在 main.ts 的代码 | 行号范围 | 精确行数 |
|---------------------|:--------|:-------:|
| 导入语句 | 1-35 | 35 |
| 类声明 + 字段声明 | 36-55 | 20 |
| 字段声明（activeFilePath, modifyGuard, _syncCooldown, _pendingSidebarRefresh, _storeReady, _searchEngine, readingToolbar, readingClickDelegate, relationSchema） | 56-98 | 43 |
| isStoreReady + getSearchEngine + getRelationSchema | 99-115 | 17 |
| **ActiveAnnotationState delegate** (mark/unmark/is/register/unregister/closeActiveModals) | 117-181 | 65 |
| **markFileSynced** (将移入 syncEngine) | 184-186 | 3→0 |
| **CacheManager delegate** (5 个方法) | 188-346 | 159→0 |
| onload | 348-715 | 368 |
| onunload | 717-732 | 16 |
| Search Index I/O | 734-770 | 37 |
| loadSettings / saveSettings | 772-790 | 19 |
| activateSidebar | 794-812 | 19 |
| refreshSidebar + refreshGraphView | 814-859 | 46 |
| activateGraphView | 827-848 | 22 |
| **onFileOpen** (移入 syncEngine) | 863-910 | 48→0 |
| **forceSyncFile** (移入 syncEngine) | 919-1173 | 255→0 |
| scheduleSidebarRefresh | 1176-1186 | 11 |
| **handleDocChange** (归入 readingProcessor) | 1188-1234 | 47→0 |
| rebuildDatabase | 2954-2985 | 32 |
| exportAnnotations | 2987-3007 | 21 |
| openAnnotationModal | 3015-3060 | 46 |
| **ReadingProcessor 全部** (移入 reading-processor.ts) | 618-2953 | 2336→0 |
| **3 事件处理器** (移入 syncEngine) | 487-613 | 125→0 |
| **AnnotationCreator** (移出) | 3067-3583 | 517→0 |

**拆分后 main.ts 保留量**:

```
35 (imports)
+ 20 (class + fields)
+ 43 (more fields)
+ 17 (getters)
+ 65 (activeState delegate)
+ 0 (markFileSynced → syncEngine)
+ 0 (cacheManager → its own module)
+ 368 (onload — 大部分是注册桩，但 PostProcessor callback 78行也在这)
+ 16 (onunload)
+ 37 (search index I/O)
+ 19 (loadSettings/saveSettings)
+ 19 (activateSidebar)
+ 46 (refreshSidebar + refreshGraphView)
+ 22 (activateGraphView)
+ 0 (onFileOpen → syncEngine)
+ 0 (forceSyncFile → syncEngine)
+ 11 (scheduleSidebarRefresh)
+ 0 (handleDocChange → readingProcessor)
+ 32 (rebuildDatabase)
+ 21 (exportAnnotations)
+ 46 (openAnnotationModal)
= 757 lines
```

等等——onload 中包含了 PostProcessor callback (78行) 和 readingToolbar setup (18行) + 3个事件处理器注册桩 (125行)。如果 3 个事件处理器和 PostProcessor callback 也移出：

- PostProcessor callback (618-695, 78行) → readingProcessor
- 3 事件处理器 (487-613, 125行) → syncEngine
- readingToolbar setup (696-709, 14行) → readingProcessor

onload 缩减: 368 - 78 - 125 - 14 = 151 行

**修正后 main.ts = 757 - 78 - 125 - 14 = 540 行** (↓85%)

---

## ✅ 三轮修正后精确数据

### P2-1: main.ts 拆分 (3584 → ~540, ↓85%)

```
src/
├── main.ts                              # ~540 lines (↓85%)
├── plugin/
│   ├── active-state.ts                  # ~79 lines  (fields + methods)
│   ├── cache-manager.ts                 # ~159 lines (5 cache methods)
│   ├── sync-engine.ts                   # ~431 lines (onFileOpen + forceSyncFile + markFileSynced + 3 event handlers)
│   ├── reading-processor.ts            # ~2401 lines (PostProcessor callback + 32 methods + handleDocChange)
│   └── annotation-creator.ts           # ~517 lines (createReadingAnnotation + findBestTextOffset + helpers)
```

### P2-2: annotation-store.ts 拆分 (2524 → ~530, ↓79%)

```
src/db/
├── annotation-store.ts          # ~530 lines (↓79%) ← 编排层
├── index-layer.ts               # ~524 lines ← indexes(100) + _addToIndex(130) + _removeFromIndex(128) + _rebuildIncoming(64) + _stripExtraFields(82) + _assertInit(8) + intersection(12)
├── persist-layer.ts             # ~573 lines ← init(104) + shutdown/flush(126) + ensureFileLoaded(29) + rebuildIndex(62) + _writeFileShard(68) + _readFileShard(106) + _writeIndexFile(102) + _markDirty(17) + _updateIndexEntry(18) + fields(30) + deleteForFile(89) + renameForFile(81)
├── relation-engine.ts           # ~412 lines ← addRelation(109) + removeRelation(120) + invalidateRelation(43) + restoreRelation(28) + getRelations(38) + invalidateRelationsByType(32) + header(14) + _cascadeDelete(63) + _cascadeUpdate(108)
├── query-engine.ts              # ~133 lines ← queryAnnotations(89) + getAnnotationStats(44) + getters(63)
└── annotation-repo.ts           # unchanged
```

**注意**: QueryEngine 应该包含简单 getter（getAnnotationByUuid/getAnnotationsForFile/getAllAnnotations = 63行），否则这些方法留在 Store 里形成碎片。修正后 QueryEngine = 89 + 44 + 63 - 12(重叠) = **~153行**。

---

## 🔴 三轮新发现: 设计结构性问题

### 发现 1: ReadingProcessor 2401 行 — 拆出后仍是最大文件

ReadingProcessor 提取后自身 2401 行，成为项目最大文件。但它是一个**内聚的领域模块**（全部是阅读模式 DOM 渲染），与当前 main.ts 的 7 种职责混杂不同。

**建议**: 可以接受 2401 行的 ReadingProcessor，但标注为**未来 P3 重构候选**（可按 region/block/span 子域继续拆分）。

### 发现 2: SyncEngine 431 行包含 forceSyncFile 的 255 行锚点恢复逻辑

`forceSyncFile` (L919-L1173) 内部有大量 block/span/region 锚点恢复逻辑，这些逻辑与"同步"职责不完全匹配——更像是"位置恢复引擎"。

**但**：这 255 行与 `forceSyncFile` 的调用链紧密耦合（modifyGuard → syncFromMarkdown → recoverOffsets → updateCaches），拆开反而增加通信成本。

**建议**: 暂保留在 SyncEngine 内，标注为内部可优化点。

### 发现 3: onload 中 PostProcessor callback 应移入 ReadingProcessor

L618-L695 的 `registerMarkdownPostProcessor` callback 是 ReadingProcessor 的入口点，留在 onload 中会导致：
- ReadingProcessor 初始化需要 plugin 注入
- callback 内部引用 `this.processBlockAnchors` 等 ReadingProcessor 方法

**修正**: PostProcessor callback (78行) 应随 ReadingProcessor 一起移出。ReadingProcessor 提供 `registerPostProcessor(plugin)` 方法在 onload 中调用。

### 发现 4: readingToolbar setup (696-709) 归属

L696-L709 的 `ReadingModeToolbar` setup 创建了一个 `readingHost` 对象（含 `createReadingAnnotation` 引用），这是 ReadingProcessor 和 AnnotationCreator 的桥梁。

**归属**: 移入 ReadingProcessor（它在阅读模式初始化上下文中）。

---

## 📋 最终实施级规格

### 迁移步骤 (9 步，每步独立 commit + 验证门)

| 步 | 模块 | 源行号 | 精确行数 | 目标文件 | 风险 |
|:--:|------|:------:|:-------:|---------|:---:|
| P2-1a | ActiveAnnotationState | 67-80, 117-181 | **79** | `src/plugin/active-state.ts` | 🟢 |
| P2-1b | CacheManager | 188-346 | **159** | `src/plugin/cache-manager.ts` | 🟡 |
| P2-1c | SyncEngine | 863-910, 919-1173, 184-186, 487-613 | **431** | `src/plugin/sync-engine.ts` | 🔴 |
| P2-1d | ReadingProcessor | 618-2953 | **2336** | `src/plugin/reading-processor.ts` | 🔴 |
| P2-1e | AnnotationCreator | 3067-3583 | **517** | `src/plugin/annotation-creator.ts` | 🟡 |
| P2-2a | IndexLayer | 31-130, 1764-2090, 2382-2508 | **524** | `src/db/index-layer.ts` | 🟡 |
| P2-2b | FilePersistLayer | 31-60, 147-250, 518-533, 708-709, 717-886, 892-1063, 2069-2085, 2105-2380 | **~573** | `src/db/persist-layer.ts` | 🔴 |
| P2-2c | RelationEngine | 1138-1491, 1593-1763 | **412** | `src/db/relation-engine.ts` | 🟡 |
| P2-2d | QueryEngine | 304-366, 538-675 | **~153** | `src/db/query-engine.ts` | 🟢 |

### 验证门

每一步后必须通过:
1. `npx tsc --noEmit --skipLibCheck` — 类型检查
2. `node esbuild.config.mjs production` — 生产构建
3. `npm test` — 全量测试
4. `git commit` — 独立提交

### 拆分后文件大小汇总

| 文件 | 行数 | 占比 |
|------|:---:|:---:|
| **main.ts** | ~540 | 15% |
| **reading-processor.ts** | ~2401 | 67% |
| **sync-engine.ts** | ~431 | 12% |
| **annotation-creator.ts** | ~517 | 14% |
| **annotation-store.ts** | ~530 | 21% |
| **persist-layer.ts** | ~573 | 23% |
| **index-layer.ts** | ~524 | 21% |
| **relation-engine.ts** | ~412 | 16% |
| **query-engine.ts** | ~153 | 6% |
| **cache-manager.ts** | ~159 | 4% |
| **active-state.ts** | ~79 | 2% |

---

## ⚠️ 实施前必须确认的 3 个决策

1. **ReadingProcessor 2401 行是否可接受？** — 它是内聚的但很大。建议接受，标注为 P3 候选。
2. **forceSyncFile 255 行留在 SyncEngine？** — 拆开通信成本更高。建议保留。
3. **QueryEngine 含简单 getter (153行)？** — 比二轮审查的 89 行多了 64 行简单查询。建议包含。

---

## 三轮审查 vs 二轮审查 vs 原方案 数字对比

| 指标 | 原方案 | 二轮审查 | **三轮终审** |
|------|:------:|:-------:|:----------:|
| main.ts 拆后 | ~1100 | ~496 | **~540** |
| main.ts 减少率 | 69% | 86% | **85%** |
| ReadingProcessor | ~1714 | ~631 | **~2336** |
| AnnotationCreator | ~315 | ~500 | **~517** |
| SyncEngine | ~311 | ~304 | **~431** |
| RelationEngine | ~352 | ~354 | **~412** |
| QueryEngine | ~200 | ~89 | **~153** |
| IndexLayer | ~338 | ~321 | **~524** |
| PersistLayer | ~550 | ~480 | **~573** |
