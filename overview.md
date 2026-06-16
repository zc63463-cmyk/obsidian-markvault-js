# BUG-8 修复 + Relation Graph 深度审查

## BUG-8 修复: RangeError: Field is not present in this state

**根因**: Obsidian 关闭/切换标签页时 `beforeUnload→saveHistory→field()` 拆解 CM6 state，但 `view.destroyed` 尚未设为 true，此时 `requestRegionLayerRedraw()` dispatch effect 到已部分销毁的 view 触发 RangeError。

**修复**:
1. `highlight-applier.ts` — `requestRegionLayerRedraw()` 增加 `state.field` 有效性检查 + catch 中清除过期引用
2. `main.ts` — `onunload()` 首行 `setActiveEditorView(null)` 切断引用

**构建 + 部署**: ✅

---

## Relation Graph 深度审查 (v5.4~v5.11)

### 审查文件
- `src/ui/graph/RelationGraphView.ts` (~1189 行)
- `src/ui/graph/graph-data-builder.ts` (~461 行)
- `src/ui/graph/graph-types.ts` (~27 行)
- `styles.css` 图谱部分 (~240 行)
- `tests/graph-data-builder.test.ts` (~357 行)

### 🔴 发现的问题

#### BUG-9: `rebuildAdjacencyMap` 在 force-graph 替换 source/target 后使用 string cast 失效

**文件**: `RelationGraphView.ts:868-870`
```typescript
const sourceId = link.source as string;
const targetId = link.target as string;
```

**问题**: `force-graph` 在 `graphData()` 注入数据后，会将 link 的 `source`/`target` 从 string 替换为 GraphNode 对象引用。在 `refresh()` 中调用 `this.fg.graphData(graphData)` 后，graphData.links 中的 source/target 已被 force-graph 内部替换为对象。

`rebuildAdjacencyMap()` 直接 `as string` 强转，得到的是 `[object Object]`（GraphNode.toString()），而非 UUID 字符串。**这导致邻接表完全失效**，hover 高亮和搜索高亮无法正确匹配节点。

**影响范围**: 
- `handleNodeHover()` → 邻居高亮不工作
- `applySearchHighlight()` → 搜索高亮不工作

**修复方案**: 在 `rebuildAdjacencyMap` 中安全提取 ID：
```typescript
const sourceId = typeof link.source === 'string' ? link.source : (link.source as any).id;
const targetId = typeof link.target === 'string' ? link.target : (link.target as any).id;
```

注意：`bfsReachable()` (graph-data-builder.ts:325-326) 中已有同样的防御性处理，可参考。

#### BUG-10: `refresh()` 中 zoomToFit 在每次 refresh 时都触发

**文件**: `RelationGraphView.ts:800-804`
```typescript
if (graphData.nodes.length > 0) {
  setTimeout(() => {
    this.fg?.zoomToFit(400, 50);
  }, 500);
}
```

**问题**: 每次 `refresh()` 调用（包括切换 filter chip、搜索输入等）都会重置视口到 fit-all，用户手动缩放/平移的操作被频繁覆盖。这非常影响用户体验 — 每次点击一个 chip 就被弹回全局视图。

**建议**: 只在首次加载和显式点击 Fit 按钮时 zoomToFit，filter 变化时保持当前视口。

#### ⚠️ 性能: `renderToolbar()` 每次 filter 变化都完全重建 DOM

**文件**: `RelationGraphView.ts:228, 248`
```typescript
chip.addEventListener('click', () => {
  this.toggleFilterArray('relationTypes', rt);
  this.refresh();
  this.renderToolbar(); // ← 完全重建 4 行 toolbar
});
```

**问题**: 点击一个 chip → refresh (重建图谱数据) + renderToolbar (重建 30+ 个 chip 的 DOM)。renderToolbar 调用 `this.toolbarEl.empty()` 销毁所有子节点再重建。对于频繁操作（连续切换多个 filter），这会产生不必要的 DOM 抖动。

**影响**: 功能正常，但 16 active + 11 passive = 27 个 chip 的 DOM 重建在高频操作下可能有感知延迟。

**建议**: 只更新受影响 chip 的 active/dim class，而非全量重建。

### 🟢 代码质量评价

| 维度 | 评分 | 说明 |
|------|:--:|------|
| 类型安全 | A | GraphNode/GraphLink/GraphFilter 接口清晰，类型断言最小化 |
| 算法正确性 | B+ | BFS/curvature/dedup 逻辑正确，但 adjacencyMap 有 BUG-9 |
| 性能优化 | B | uuidMap O(1) 查询、degreeMap 预计算好，但 renderToolbar 全量重建 |
| 主题适配 | A | 暗亮主题完整覆盖 |
| 代码组织 | A- | graph-types.ts 独立避免循环依赖，但 RelationGraphView+NodeDetailModal 1189 行略大 |
| 测试覆盖 | B+ | 17 个测试覆盖核心路径，但缺少 adjacencyMap/renderToolbar 测试 |

### 📋 修复优先级

| # | 问题 | 优先级 | 工作量 |
|---|------|:--:|:--:|
| BUG-9 | adjacencyMap source/target 强转失效 | 🔴 P0 | 5 min |
| BUG-10 | refresh 每次都 zoomToFit | 🟡 P1 | 10 min |
| — | renderToolbar 全量重建优化 | 🟢 P2 | 30 min |
