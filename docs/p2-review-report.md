# P2-1/P2-2 拆分设计 — 深度审查修正报告

> **审查人**: Senior Developer | **审查日期**: 2026-06-16 09:45
> **审查对象**: `docs/p2-split-design.md` + `docs/p2-class-diagram.mermaid`

---

## 🔴 错误 1: annotation-store.ts 行数错误 — 实际 2524 不是 2400

**原文**: "~2400 行"（设计文档 §1.2）
**实际**: 2524 行 (`wc -l`)

**影响**: 各子模块行数估算偏低，persist-layer 实际比估算多 ~50 行。

---

## 🔴 错误 2: P2-1 main.ts 行数严重低估 — 5 个遗漏职责

**原文**: main.ts 拆后 ~1100 行，包含 Annotation Modal (~104 lines) + Create Annotation (~192 lines) + Text Search Helpers (~321 lines)

**实际遗漏**（原文未计入 main.ts 保留量）:

| 遗漏区域 | 行号范围 | 实际行数 | 设计文档声称 |
|---------|---------|:---:|:---:|
| **`rebuildDatabase()`** | 2954-2985 | ~31 | ❌ 未提及 |
| **`exportAnnotations()`** | 2987-3007 | ~20 | ❌ 未提及 |
| **`createReadingAnnotation()`** | 3067-3250 | ~183 | ❌ 仅 192 行估算 |
| **`findBestTextOffset()` + 5 个辅助纯函数** | 3268-3583 | ~315 | ✅ 321 行估算 |
| **`handleDocChange()` + offset tracking** | 1188-1234 | ~46 | ❌ 未在保留量中 |

**修正后 main.ts 保留量**:

| 来源 | 原估算 | 修正 |
|------|:---:|:---:|
| 导入 + 字段声明 | ~50 | ~50 |
| Active State delegate | ~30 | ~30 |
| Settings load/save | ~20 | ~20 |
| Sidebar/GraphView 激活 | ~65 | ~65 |
| **onload 事件注册** | ~250 | **~370** ← 含 delete/rename/active-leaf-change 事件处理内联逻辑 |
| onunload | ~15 | ~15 |
| Search Index I/O | ~30 | ~30 |
| Annotation Modal | ~100 | ~100 |
| Create Annotation | ~190 | ~190 |
| Text Search Helpers | ~320 | ~320 |
| **rebuildDatabase** | 0 | **~31** |
| **exportAnnotations** | 0 | **~20** |
| 空行 + 注释 | ~30 | ~30 |
| **合计** | **~1100** | **~1441** |

**结论**: main.ts 拆后 ~1441 行（减少 60%，不是 69%）。

---

## 🔴 错误 3: onload 事件处理内联代码不应留在 main.ts

**原文** §2.2: "保留在主文件的事件注册 (onload 内部) — ~250 lines"

**关键问题**: 设计文档声称 delete/rename/active-leaf-change 事件注册代码保留在 main.ts，但未计算这些事件处理函数内部的业务逻辑行数。

实际代码审查发现：

1. **`vault.on('delete', ...)`**: 487-527 行 = **40 行**（含 `closeActiveModalsForFile`, `_activeAnnotationUuidToFilePath` 清理, `annotationStore.deleteAnnotationsForFile`, `clearSpanCacheForFile`, `refreshSidebar`）
2. **`vault.on('rename', ...)`**: 529-577 行 = **48 行**（含 `closeActiveModalsForFile`, `annotationStore.renameAnnotationsForFile`, `activeFilePath` 更新, `_activeAnnotationUuidToFilePath` 批量更新, `_syncCooldown` 迁移, `refreshSidebar`）
3. **`workspace.on('active-leaf-change', ...)`**: 579-613 行 = **34 行**（含 `setActiveEditorView`, `annotationStore.ensureFileLoaded`, `updateSpanCache`, `updateRegionCache`, `requestRegionLayerRedraw`, `scheduleSidebarRefresh`）

这三个事件处理器内部**直接操作 `this._activeAnnotation*`、`this._syncCooldown`、`annotationStore`**，与 syncEngine / activeState 紧密耦合。如果留在 main.ts，拆分后 main.ts 依然是一个 1441 行的"巨物"。

**修正方案**: 这些事件处理器应该**也移入 syncEngine**。syncEngine 已持有 `_syncCooldown` 和 `activeState` 引用，删除/重命名/leaf-change 的处理逻辑与 sync 职责一致。

**修正后 onload 仅保留注册桩**:

```typescript
// onload 中仅保留注册桩（调用 syncEngine 的方法）
this.registerEvent(this.app.workspace.on('file-open', (file) => this.syncEngine.onFileOpen(file)));
this.registerEvent(this.app.vault.on('delete', (file) => this.syncEngine.onFileDelete(file)));
this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.syncEngine.onFileRename(file, oldPath)));
this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.syncEngine.onActiveLeafChange()));
```

**修正后 onload 注册行数**: ~40 行（而非 ~370 行）

---

## 🟡 错误 4: SyncEngine API 不完整 — 缺少 3 个事件处理方法

**原文** §2.2: SyncEngine 只定义了 `onFileOpen` + `forceSyncFile` + `scheduleSidebarRefresh`

**遗漏**: SyncEngine 还需要:

```typescript
async onFileDelete(file: TFile): Promise<void>;     // vault.on('delete') 处理逻辑
async onFileRename(file: TFile, oldPath: string): Promise<void>; // vault.on('rename') 处理逻辑
async onActiveLeafChange(): Promise<void>;           // workspace.on('active-leaf-change') 处理逻辑
```

这三个方法内部操作 `_syncCooldown`、`activeState`、`annotationStore` — 全部已在 syncEngine 可访问范围内。

---

## 🟡 错误 5: `markFileSynced` 被重复归属

**原文**: `markFileSynced` 在 CacheManager 中定义
**实际**: `markFileSynced` (L184) 操作的是 `_syncCooldown` — 这是 syncEngine 的内部状态，不是 cache 逻辑。

**修正**: `markFileSynced` 应归入 SyncEngine:

```typescript
// AnnotationSyncEngine (修正后)
markFileSynced(filePath: string): void;  // 写 _syncCooldown
```

CacheManager 不应包含此方法。

---

## 🟡 错误 6: ReadingProcessor 行数低估 + 缺少 createAnnotation/TextSearch

**原文**: ReadingProcessor ~1714 lines (lines 618-695 + 1236-2950)
**实际**: ReadingProcessor 还包含:

- `processInlineMarks` (marks 高亮处理) — 在 postProcessor 入口内 (L618-659)
- `processNativeAnnotations` — 实际是独立 async 方法
- `hideLeakedAnchorText` — 应在 ReadingProcessor
- `applyRegionStyleToMiddleSection` — region 递归样式方法 (L2757-2795)

但 **`createReadingAnnotation()`** (3067-3250) 和 **`findBestTextOffset()` + 5 辅助纯函数** (3268-3583) **不应在 ReadingProcessor 中** — 它们是标注创建逻辑，不是渲染逻辑。

**修正方案**: 这两个区域应提取到独立模块 `src/plugin/annotation-creator.ts`:

```typescript
export class AnnotationCreator {
  constructor(private plugin: MarkVaultPlugin) {}
  
  async createReadingAnnotation(selectedText, color, type, kind): Promise<void>;
  
  // ── 纯函数（可 static） ──
  private findBestTextOffset(content, selectedText): OffsetResult | null;
  private findByFuzzySlidingWindow(...): OffsetResult | null;
  private findByTextSnippets(...): OffsetResult | null;
  private tokenizeForFuzzy(text): string[];
  private normalizeSelectedText(text): string;
  private findBlockBoundary(beforeText): number;
}
```

**行数**: ~315 lines (3268-3583 纯函数 + 3067-3250 创建标注)

---

## 🔴 错误 7: annotation-store.ts 行数分布全部低估

**原文** §1.2 的行数估算 vs 实际 (`wc -l` + 逐段扫描):

| 区域 | 原文估算 | 实际 |
|------|:---:|:---:|
| 12 索引声明 + I/O 工具 | ~83 | ~97 (31-130) |
| initialize/shutdown | ~218 | ~284 (147-430 含 CRUD 前) |
| CRUD (add/update/delete) | ~313 | ~367 (367-733 含 batch) |
| File Management | ~333 | ~367 (717-1083 含 delete/rename) |
| Tag Operations | ~65 | ~47 (1070-1117) |
| **Relation Engine** | **~352** | **~420** (1138-1759 含 invalidate/restore) |
| Flag & Group | ~92 | ~92 (1493-1585) |
| **Index Maintenance** | **~298** | **~262** (1764-2025) |
| **Query Engine** | **~400** | **~95** (538-626 + 632-675 = ~95 行) |

**关键修正**: 

- **Query Engine 实际只有 ~95 行**，不是 400 行！`queryAnnotations()` + `getAnnotationStats()` 两个方法合计不到 100 行。设计文档的 400 行估算严重虚高。
- **Relation Engine 实际 ~420 行**，多了 invalidate/restore 两个方法 (~70 行) 未计入。
- **File Management 实际 ~367 行**（含 `deleteAnnotationsForFile` + `renameAnnotationsForFile`），这些在设计文档归入了 persist-layer 但实际在 Store 内直接操作索引。

---

## 🟡 错误 8: IndexLayer + PersistLayer 耦合被低估

**原文** §3.2: "IndexLayer 和 PersistLayer 互相独立，Store 是唯一编排者"

**实际代码发现**: `ensureFileLoaded()` (717-745) 和 `rebuildIndex()` (825-886) **同时操作索引和文件 I/O**:

```typescript
// ensureFileLoaded: 既读文件又写索引
async ensureFileLoaded(filePath) {
  const annotations = await this._readFileShard(filePath); // persist
  for (const ann of annotations) {
    this._byUuid.set(clean.uuid, clean);  // index
    this._byFile.get(filePath)!.add(clean.uuid);  // index
    this._addToIndex(clean);  // index
  }
  this._loadedFiles.add(filePath); // persist state
}
```

**修正**: PersistLayer 的 `ensureFileLoaded` 必须调用 IndexLayer 的 `add()`。这不是"互相独立"——PersistLayer **依赖** IndexLayer 来完成加载后的索引更新。

**修正设计**: PersistLayer `ensureFileLoaded()` 应返回 Annotation[]，由 Store 编排层负责索引更新:

```typescript
// Store 层编排
async ensureFileLoaded(filePath) {
  const annotations = await this.persist.loadFileShard(filePath);
  for (const ann of annotations) {
    this.index.add(ann);
  }
  this.persist.markLoaded(filePath);
}
```

---

## 🟡 错误 9: annotationStore 是全局单例 — 拆分需保持 singleton 模式

**原文**: 未提及 `annotationStore` 是全局导出的单例 (`export let annotationStore: AnnotationStore`)

**实际**: `annotationStore` 在 `annotation-store.ts` 底部通过 `initAnnotationStore()` 创建，然后被 **11 个文件** 直接 import 使用（main.ts, context-menu.ts, RelationGraphView.ts, settings-tab.ts, migration.ts, annotation-repo.ts, markdown-sync.ts, offset-tracker.ts, search-engine.ts, w3c-export.ts, w3c-import.ts）。

**修正**: 拆分后必须保持 `export let annotationStore` 单例不变。所有子模块（IndexLayer/PersistLayer/RelationEngine/QueryEngine）都是 AnnotationStore 的内部组合，不直接对外导出。外部使用者仍然通过 `import { annotationStore } from './db/annotation-store'` 访问。

---

## 🟡 错误 10: `_addToIndex` 需要 `annotationStore._byUuid` — 不能简单搬入 IndexLayer

**原文**: `_addToIndex` 逻辑归入 IndexLayer
**实际**: `_addToIndex` (L1764-1893) 内部需要访问 `_byUuid` 来获取 annotation 对象。但 `_byUuid` 是 IndexLayer 自己管理的 Map——没问题。

**真正的问题**: `_addToIndex` 最后调用 `_rebuildIncomingIndexFor(uuid)` (L1892)，该方法扫描**所有其他标注的 `_byRelationOut`**。这意味着 IndexLayer 的 `add()` 不是"原子操作"——它需要全局扫描。

**修正**: 保持 `_rebuildIncomingIndexFor` 在 IndexLayer 内（它只操作 IndexLayer 的 Map），但要在文档中明确标注这不是真正的"原子操作"，而是"局部原子 + 全局修复"。

---

## 📊 修正后完整数据

### P2-1 修正后 main.ts 拆分

```
src/
├── main.ts                              # ~530 lines (↓ 85%) ← 大幅瘦身！
├── plugin/
│   ├── active-state.ts                  # ~68 lines (new)
│   ├── cache-manager.ts                 # ~120 lines (new) ← 去掉 markFileSynced
│   ├── sync-engine.ts                   # ~420 lines (new) ← 加 3 个事件处理 + markFileSynced
│   ├── reading-processor.ts            # ~1600 lines (new) ← 不含 create/search
│   └── annotation-creator.ts           # ~315 lines (new) ← 从 main.ts 提取
└── (rest unchanged)
```

| 指标 | 原方案 | 修正方案 |
|------|:---:|:---:|
| main.ts 拆后行数 | ~1100 | **~530** |
| 新模块数 | 4 | **5** (+annotation-creator) |
| main.ts 减少率 | 69% | **85%** |

### P2-2 修正后 annotation-store.ts 拆分

```
src/db/
├── annotation-store.ts          # ~530 lines (↓ 79%) ← 编排层含 CRUD + ensure + rebuild
├── index-layer.ts               # ~360 lines (new) ← 索引 + add/remove + rebuildIncoming
├── persist-layer.ts             # ~500 lines (new) ← 纯 I/O（loadShard/writeShard/flush/index/meta）
├── relation-engine.ts           # ~420 lines (new) ← 含 invalidate/restore
├── query-engine.ts              # ~95 lines (new) ← 精简！
└── annotation-repo.ts           # unchanged
```

| 指标 | 原方案 | 修正方案 |
|------|:---:|:---:|
| annotation-store.ts 拆后行数 | ~450 | **~530** |
| QueryEngine 行数 | ~200 | **~95** |
| RelationEngine 行数 | ~352 | **~420** |
| PersistLayer 行数 | ~550 | **~500** |

---

## 🔄 修正后迁移顺序

| 步 | 模块 | 行数 | 风险 | 依赖 |
|:--:|------|:--:|:--:|------|
| P2-1a | `ActiveAnnotationState` | 68 | 🟢 | 无 |
| P2-1b | `AnnotationCacheManager` | 120 | 🟡 | highlight-applier |
| P2-1c | `AnnotationSyncEngine` | 420 | 🔴 | a+b + 事件处理逻辑 |
| P2-1d | `ReadingModeProcessor` | 1600 | 🔴 | app.vault (少量) |
| P2-1e | `AnnotationCreator` | 315 | 🟡 | app.vault, modifyGuard |
| P2-2a | `IndexLayer` | 360 | 🟡 | 无（纯数据） |
| P2-2b | `FilePersistLayer` | 500 | 🔴 | IndexLayer (通过 Store 编排) |
| P2-2c | `RelationEngine` | 420 | 🟡 | a+b |
| P2-2d | `QueryEngine` | 95 | 🟢 | a |

**注意**: P2-1c 风险从 🔴 升高（现在包含 3 个事件处理器逻辑 + markFileSynced 迁移）。P2-1e 是新增步骤。

---

## 🆕 新增风险项

| 风险 | 说明 | 缓解 |
|------|------|------|
| **事件处理器迁移** | delete/rename/active-leaf-change 逻辑从 main.ts 移入 syncEngine，需要确保 `this.registerEvent` 回调正确绑定 | onload 中用箭头函数绑定 |
| **singleton 模式** | annotationStore 是全局单例，11 个文件 import。拆分后必须保持导出接口不变 | Store 类不变，子模块不导出 |
| **ensureFileLoaded 编排** | persist-layer 只负责 I/O，索引更新由 Store 编排 | PersistLayer 返回数据，Store 调用 index.add |
| **AnnotationCreator 与 modifyGuard** | createReadingAnnotation 需要 modifyGuard.acquire/release | 注入 plugin 引用 |

---

## ✅ 保留正确的部分

以下设计决策经审查确认无误:

1. **Store 是唯一编排者** — CRUD 方法（add/update/delete）内部的 `_removeFromIndex → merge → _addToIndex` 序列必须保留在 Store 层，不能下放到子模块
2. **循环依赖不存在** — IndexLayer ↔ PersistLayer 通过 Store 解耦，确认无循环
3. **逐文件提交策略** — 8 步验证门，每步独立 commit
4. **ActiveAnnotationState 最先提取** — 最简单，零依赖
5. **RelationEngine 需要读写 _byRelationOut/_byRelationIn** — 确认需要 IndexLayer 引用

---

## 📋 下一步

基于以上修正，需要更新 `docs/p2-split-design.md` 和 `docs/p2-class-diagram.mermaid`。是否立即执行修正？