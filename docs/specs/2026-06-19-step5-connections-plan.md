# Step 5 深度规划 — mindflow-connections.ts 拆分

> 日期: 2026-06-19 | 状态: 规划中

---

## 一、待提取函数清单 (11 个, ~500 行)

### 1A. 标注关系连线 (3 函数, ~265 行)

| 函数 | 行号 | 行数 | 职责 |
|------|------|------|------|
| `_renderRelationEdges()` | L1478-1555 | 78 | 收集 @A 节点关系 → 调用 `renderRelationEdges()` |
| `_handleRelEdgeClick()` | L1558-1686 | 129 | 左键 → 内联 Modal 展示关系详情 |
| `_handleRelEdgeContextMenu()` | L1689-1742 | 54 | 右键 → ConfirmModal → invalidate/restore |

**复杂点**: `_handleRelEdgeClick` 内联创建了一个 129 行的 Modal（含内联样式），不是独立类。

### 1B. 自主连线 (4 函数, ~155 行)

| 函数 | 行号 | 行数 | 职责 |
|------|------|------|------|
| `addConnection()` | L1745-1771 | 27 | 多选节点 → 创建 ConnectionRecord |
| `_renderConnectionEdges()` | L1774-1877 | 104 | 渲染紫色虚线 + hitArea + 箭头 |
| `removeConnection()` | L1879-1913 | 35 | ConfirmModal → 硬删除 |
| `_editConnection()` | L1915-1930 | 16 | ConnectionEditModal → 编辑 label/note |

### 1C. 标注集成 (3 函数, ~75 行)

| 函数 | 行号 | 行数 | 职责 |
|------|------|------|------|
| `openAnnotationPicker()` | L1039-1087 | 49 | AnnotationPickerModal → 创建 @A 节点 |
| `jumpToAnnotation()` | L1091-1110 | 20 | 打开标注所在文件 |
| `showAnnotationDetail()` | L1246-1263 | 18 | AnnotationDetailModal → 详情 |

### 1D. 边标签编辑 (1 函数, ~22 行)

| 函数 | 行号 | 行数 | 职责 |
|------|------|------|------|
| `_openEdgeLabelEditor()` | L1131-1152 | 22 | PromptModal × 2 → edgeLabel/edgeNote |

---

## 二、依赖分析

### 2A. 对 MindFlowView 状态的访问

| 状态 | 访问者 | 方式 |
|------|--------|------|
| `rootNode` | 全部 11 个函数 | 读取 |
| `nodeElements` | `_renderRelationEdges`, `_renderConnectionEdges` | 读取 |
| `_relSvgEl` | `_renderRelationEdges`, `_renderConnectionEdges` | 读写 |
| `_connections` | `addConnection`, `_renderConnectionEdges`, `removeConnection`, `_editConnection` | 读写 |
| `meta` | `addConnection`, `removeConnection`, `_editConnection` | 读写 |
| `selectedNodeId` | `openAnnotationPicker` | 读取 |
| `app` (annotationStore) | `_renderRelationEdges`, `_handleRelEdgeClick`, `_handleRelEdgeContextMenu`, `openAnnotationPicker`, `jumpToAnnotation`, `showAnnotationDetail` | 读取 |

### 2B. 对 MindFlowView 方法的调用

| 方法 | 调用者 |
|------|--------|
| `debouncedSave()` | addConnection, removeConnection, _editConnection, _openEdgeLabelEditor |
| `_renderConnectionEdges()` | addConnection, removeConnection, _editConnection |
| `_renderRelationEdges()` | _handleRelEdgeContextMenu (自调用) |
| `layoutAndRender()` | openAnnotationPicker, _openEdgeLabelEditor |
| `selectNode()` | openAnnotationPicker, _openEdgeLabelEditor |
| `renderCache.clear()` | openAnnotationPicker, _openEdgeLabelEditor |
| `undoRedo.snapshot()` | openAnnotationPicker |
| `eventBus.emit()` | openAnnotationPicker |
| `_getBoundaryCandidateIds()` | addConnection |
| `_multiSelectedIds.clear()` | addConnection |
| `_applySelectionVisual()` | addConnection |
| `jumpToAnnotation()` | showAnnotationDetail |

### 2C. 外部依赖

| 依赖 | 来源 |
|------|------|
| `renderRelationEdges`, `findNodePosition`, `getNodeRect`, `rectBoundaryIntersection`, `ensureArrowMarkers`, `RelationEdge` | `../render/svg-connector` |
| `findNode` | `../data/seed-sync` |
| `createMindNode`, `MindNode`, `ConnectionRecord` | `../types/mind-node` |
| `generateId` | `../../utils/id` |
| `logger` | `../../utils/logger` |
| `ConfirmModal`, `PromptModal` | `../../ui/confirm-modal` |
| `AnnotationPickerModal`, `AnnotationDetailModal`, `ConnectionEditModal` | `./mindflow-modals` |
| `Notice`, `Modal`, `TFile`, `App` | `obsidian` |

### 2D. 函数间互调图

```
_renderRelationEdges ──→ _handleRelEdgeClick ──→ _handleRelEdgeContextMenu
                    └──→ _handleRelEdgeContextMenu ──→ _renderRelationEdges (递归)

addConnection ──→ _renderConnectionEdges ──→ _editConnection
                                         └──→ removeConnection ──→ _renderConnectionEdges

showAnnotationDetail ──→ jumpToAnnotation
openAnnotationPicker (独立, 调用 view 操作)
_openEdgeLabelEditor (独立, 调用 view 操作)
```

---

## 三、拆分方案

### 方案 A: 单文件 `mindflow-connections.ts` (推荐)

将全部 11 个函数放入一个文件，通过 `ConnectionsContext` 接口访问视图状态。

**优点**: 函数间互调无需跨文件，递归调用自然
**缺点**: 文件约 550 行

### 方案 B: 双文件

- `mindflow-relations.ts` — 标注关系连线 (3 函数, ~265 行)
- `mindflow-connections.ts` — 自主连线 + 标注集成 + 边标签 (8 函数, ~290 行)

**优点**: 更细粒度
**缺点**: `_renderRelationEdges` 需要回调到 connections 文件中的函数（通过 context 间接调用）

### 决策: 采用方案 A

理由: 函数间互调密集（尤其 `_handleRelEdgeClick` → `_handleRelEdgeContextMenu` → `_renderRelationEdges` 递归），单文件避免 context 传递开销。

---

## 四、Context 接口设计

```typescript
export interface ConnectionsContext {
  // ── DOM ──
  rootNode: MindNode | null;
  nodeElements: Map<string, HTMLElement>;
  _relSvgEl: SVGSVGElement | null;
  nodeLayerEl: HTMLElement | null;

  // ── 数据 ──
  _connections: ConnectionRecord[];
  meta: { connections?: ConnectionRecord[] };
  selectedNodeId: string | null;

  // ── App 访问 ──
  app: App;

  // ── View 操作委托 ──
  debouncedSave: () => void;
  layoutAndRender: () => Promise<void>;
  selectNode: (id: string | null) => void;
  renderCacheClear: () => void;
  undoRedoSnapshot: (label: string) => void;
  eventBusEmit: (channel: string, data: any) => void;
  getBoundaryCandidateIds: () => string[];
  clearMultiSelect: () => void;
  applySelectionVisual: () => void;

  // ── 内部渲染互调 ──
  renderRelationEdges: () => void;
  renderConnectionEdges: () => void;
  jumpToAnnotation: (uuid: string) => void;
}
```

**关键设计**: `renderRelationEdges` 和 `renderConnectionEdges` 作为方法暴露在 context 中，使得 `addConnection` 调用 `ctx.renderConnectionEdges()` 而非 `this._renderConnectionEdges()`。

---

## 五、实施步骤

### 5.1 创建 `mindflow-connections.ts`

将 11 个函数转为纯函数，签名统一为 `function name(ctx: ConnectionsContext, ...args): ReturnType`。

### 5.2 处理 `_handleRelEdgeClick` 的内联 Modal

**选项 A**: 保持内联 Modal 代码（129 行）在函数内部
**选项 B**: 提取为 `RelationDetailModal` 类放入 `mindflow-modals.ts`

**决策**: 选项 B — 将 129 行内联 Modal 提取为独立类，保持 connections 文件简洁。

### 5.3 在 `mindflow-view.ts` 中添加委托

```typescript
// Connections 委托
private _renderRelationEdges(): void { renderRelationEdgesFn(this._buildConnectionsCtx()); }
private _handleRelEdgeClick(edge: RelationEdge, e: MouseEvent): void { handleRelEdgeClick(this._buildConnectionsCtx(), edge, e); }
private _handleRelEdgeContextMenu(edge: RelationEdge, e: MouseEvent): Promise<void> { return handleRelEdgeContextMenu(this._buildConnectionsCtx(), edge, e); }
private addConnection(): void { addConnectionFn(this._buildConnectionsCtx()); }
private _renderConnectionEdges(): void { renderConnectionEdgesFn(this._buildConnectionsCtx()); }
private async removeConnection(id: string): Promise<void> { await removeConnectionFn(this._buildConnectionsCtx(), id); }
private _editConnection(id: string): void { editConnectionFn(this._buildConnectionsCtx(), id); }
private openAnnotationPicker(): void { openAnnotationPickerFn(this._buildConnectionsCtx()); }
private jumpToAnnotation(uuid: string): void { jumpToAnnotationFn(this._buildConnectionsCtx(), uuid); }
private showAnnotationDetail(uuid: string): void { showAnnotationDetailFn(this._buildConnectionsCtx(), uuid); }
private async _openEdgeLabelEditor(id: string): Promise<void> { await openEdgeLabelEditorFn(this._buildConnectionsCtx(), id); }
```

### 5.4 构建 `_buildConnectionsCtx()`

与 `_buildMinimapCtx()` / `_buildBoundaryCtx()` 模式一致，使用 getter/setter 代理。

### 5.5 验证

- tsc --noEmit: 0 errors
- npm test: 全绿
- npm run deploy: 成功
- Obsidian 中功能验证: 连线渲染/编辑/删除/关系详情/标注选择器

---

## 六、风险评估

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| `_handleRelEdgeClick` 内联 Modal 提取为类可能遗漏样式 | 中 | 逐行比对，保留所有内联样式 |
| `app as any` 访问 annotationStore 的类型问题 | 低 | 保持现有模式，context 中 app 类型为 App |
| 递归调用 `_renderRelationEdges` → ctx.renderRelationEdges 可能死循环 | 低 | 与现有逻辑一致，无新增递归路径 |
| `_buildConnectionsCtx()` 每次调用创建新对象 | 低 | 与 outline/minimap 一致，GC 可处理 |
| `RelationDetailModal` 需要访问 RELATION_COLOR_MAP | 低 | 将颜色映射移到 modals 文件或从 svg-connector 导出 |

---

## 七、预期效果

| 指标 | Step 4 后 | Step 5 后 |
|------|-----------|-----------|
| `mindflow-view.ts` | 2615 行 | **~2050 行** |
| `mindflow-connections.ts` | — | ~420 行 |
| `mindflow-modals.ts` | 738 行 | ~850 行 (+RelationDetailModal) |
| 文件总数 | 5 | **6** |
