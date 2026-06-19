# MindFlow 深度审查报告

> 审查日期: 2026-06-18 | 审查范围: `src/mindflow/` 全部 9 个模块 + CSS + 测试 + main.ts 集成

## 审查结论

**当前状态**: Phase 2 功能基本实现，但有 **4 个 P0 级架构缺陷** 导致渲染体验不达标。核心问题集中在**宽度测量管道**和**持久化层 YAML 序列化**。

---

## P0 — 核心功能缺陷（必须修复）

### P0-1: 宽度测量循环依赖（根因）

**文件**: `render/node-renderer.ts:156-161`

**问题**: `renderNode()` 在骨架阶段设置了 `el.style.width = layout.width`（估算值）。随后 `renderNodeContent()` 测量 `contentEl.scrollWidth`——但此时父元素 `el` 已有固定 width，`scrollWidth` 返回的是被父元素约束后的宽度，**不是内容的自然宽度**。

```
renderNode() → el.style.width = 200px (估算)
  ↓
renderNodeContent() → contentEl.scrollWidth → 受 200px 约束 → 可能返回 200
  ↓
finalWidth = 200 + 28 = 228 → 与估算值几乎相同 → 宽度永远不对
```

**修复方向**: 测量前临时移除父元素宽度约束：
```typescript
const oldWidth = el.style.width;
el.style.width = 'auto';
await MarkdownRenderer.render(...);
const naturalWidth = contentEl.offsetWidth;
el.style.width = oldWidth; // 恢复
// 然后设置最终宽度
```

### P0-2: 缓存命中时不更新 DOM 宽度

**文件**: `render/node-renderer.ts:117-123`

**问题**: 缓存命中时只设 `node.renderedWidth = cached.width`，但**不设 `el.style.width`**。折叠/展开后 `layoutAndRender()` 重新渲染节点，骨架阶段 `renderNode()` 用估算宽度设 `el.style.width`，缓存命中跳过了实际渲染——DOM 宽度停留在估算值。

**修复方向**: 缓存命中分支补充 `el.style.width = cached.width + 'px'`。

### P0-3: YAML 序列化在多行文本时损坏

**文件**: `data/frontmatter-sync.ts:214-219`

**问题**: `yamlString()` 检测到 `\n` 时用双引号包裹，但只转义 `"` 不转义换行符。YAML 双引号字符串中裸换行会被解析为多行值，破坏 frontmatter 结构。

测试样本中的 `free-code-1` 节点包含 `\n`（代码块），保存后重新加载会导致解析错误。

**修复方向**:
```typescript
function yamlString(value: string): string {
  if (/[:#\[\]{}&*!|>'"%@`\n]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return value;
}
```

### P0-4: parentId 行号脆弱（已知的 Bug 2）

**文件**: `data/md-parser.ts:89` + `data/frontmatter-sync.ts`

**问题**: MD-Seed ID = `md-{lineNumber}`。添加/删除 Free 节点 → frontmatter 行数变化 → MD-Seed 行号偏移 → `parentId` 引用断裂。

**当前状态**: 每次保存 Free 节点后重新解析时，7 个 Free 节点全部变孤儿。

**修复方向**: 改用 `heading-text-hash` 作为 MD-Seed ID（如 `md-{sha256(text).slice(0,8)}`），或写入 frontmatter 时自动修正 parentId 映射。

---

## P1 — 体验降级（应该修复）

### P1-1: saveFreeNodes() 无防抖

**文件**: `view/mindflow-view.ts:451-455`

每次操作（insertChild/insertSibling/removeNode/editNode）都触发 `saveFreeNodes()`，内部做 `vault.read()` + `vault.modify()` 完整 I/O。连续按 Tab 创建 5 个子节点 = 5 次文件读写。

**修复方向**: 添加 500ms debounce。

### P1-2: enterEditMode keydown 监听器泄漏

**文件**: `view/mindflow-view.ts:814-823`

每次 `enterEditMode()` 给 `contentEl` 添加 `keydown` 监听器，**从不移除**。`contentEl` 是同一个 DOM 元素（`enterEditMode` 只清空内容不重建），多次编辑同一节点 → 监听器累积 → `finishEdit()` 被调用多次。

**修复方向**: 使用 `{ once: true }` 或在 `finishEdit` 中 `removeEventListener`。

### P1-3: 无文件修改监听

**文件**: `view/mindflow-view.ts`

`resync()` 方法定义了但从未绑定到 `vault.on('modify')` 事件。外部编辑 .md 文件后导图不更新。

**修复方向**: `onOpen()` 中注册 `this.registerEvent(this.app.vault.on('modify', ...))`，过滤当前文件后调用 `resync()`。

### P1-4: 重布局只检查高度不检查宽度

**文件**: `layout/tree-layout.ts:193-196` + `render/node-renderer.ts:326-329`

`needsRelayout()` 和 `renderNodesContent` 的重布局判断只比较高度差异。宽度变化不触发重布局 → 兄弟节点位置不调整 → 节点重叠。

**修复方向**: 同时比较宽度差异。

### P1-5: calculateSubtreeHeight 是 O(N²)

**文件**: `layout/tree-layout.ts:104-118`

`assignLayout()` 递归调用时，每个节点都调用 `calculateSubtreeHeight()` 重新计算整个子树。对 N 个节点的树，最坏 O(N²)。大文件（100+ 节点）会卡顿。

**修复方向**: 两遍方案——先自底向上计算并缓存 subtreeHeight，再自顶向下分配坐标。

### P1-6: .mf-node__content 缺少 flex 属性

**文件**: `styles.css:3437`

移除 `flex: 1` 后，content div 不再占据剩余空间。当节点同时有 badge + collapse indicator 时，content 可能被挤压。

**修复方向**: 恢复 `flex: 1` 但配合 `min-width: 0`（允许收缩但不影响测量）。

### P1-7: DEFAULT_EXPAND_LEVEL = -1 对大文件不友好

**文件**: `view/mindflow-view.ts:66`

全展开默认值对教科书级别文件（100+ 节点）会一次创建大量 DOM + MarkdownRenderer 调用，可能导致卡顿。

**修复方向**: 改回 `2`（markmap 默认值），或根据节点总数动态决定。

---

## P2 — 代码质量 / 边界情况

| # | 文件 | 问题 | 建议 |
|---|------|------|------|
| P2-1 | `tree-layout.ts:26` | `NODE_WIDTH=240` 是死代码 | 删除 |
| P2-2 | `render-cache.ts:35` | 缓存 key 用 `text.slice(0,64)`，前64字符相同的不同节点会碰撞 | 改用完整 text 的简单哈希 |
| P2-3 | `undo-redo.ts` | Undo/Redo 不恢复 MD-Seed 的 collapsed 状态 | 快照中记录全局 collapsed 状态 |
| P2-4 | `keyboard-shortcuts.ts:148` | Backspace 映射到 deleteNode | 移除 Backspace 映射 |
| P2-5 | `mindflow-view.ts:870-881` | `applySnapshot` 重新读文件+解析MD，但文件没变 | 直接用快照中的 freeRecords 重建树 |
| P2-6 | `svg-connector.ts:96-98` + `mindflow-view.ts:364-366` | SVG 双重清空 | 移除 view 中的清空，只保留 renderConnectors 内部的 |
| P2-7 | `mindflow-view.ts:800` | `finishEdit` 用 `textContent` 而非 `innerText` | 改用 `innerText` 以正确处理换行 |
| P2-8 | `tree-layout.ts:17` | `HORIZONTAL_GAP=220` 硬编码 | 应为 `max(parentWidth, 220) + gap` 自适应 |
| P2-9 | `node-renderer.ts:130` | try 块缩进不一致（4空格 vs 2空格混合） | 统一为 2 空格 |
| P2-10 | `frontmatter-sync.ts:144` | `parseMindmapFrontmatter` 的 `!line.startsWith(' ')` 判断在 mindmap 段去缩进后可能不成立 | 用 `line.startsWith('-')` 替代列表项检测 |

---

## 架构评估

### 做得好的部分

| 模块 | 评价 |
|------|------|
| `types/mind-node.ts` | 类型定义清晰，工厂函数规范，三种节点类型+Phase 3 预留 |
| `core/event-bus.ts` | 4通道事件总线，try/catch 防护监听器异常，设计参考 mind-elixir |
| `core/undo-redo.ts` | 快照策略合理，MAX_STACK 防膨胀，深拷贝保证隔离 |
| `core/keyboard-shortcuts.ts` | IME 组合输入防护做得好，覆盖常用快捷键 |
| `data/seed-sync.ts` | 树操作 API（insertSibling/removeNode/moveNode）完整，防环检查到位 |
| `render/svg-connector.ts` | 贝塞尔曲线计算简洁，折叠/批注连线区分清晰 |

### 需要重构的部分

| 模块 | 问题 | 优先级 |
|------|------|--------|
| 宽度测量管道 | 循环依赖 + 缓存不同步 DOM | **P0** |
| YAML 序列化 | 多行文本损坏 + 行号 ID 脆弱 | **P0** |
| 布局算法 | O(N²) + 不检查宽度变化 | P1 |
| 持久化层 | 无防抖 + 无文件监听 | P1 |

---

## 测试覆盖评估

当前 57 个单元测试覆盖：
- ✅ MD 解析（标题/列表/代码块/frontmatter 跳过）
- ✅ Frontmatter 读写（写入/读取/往返一致性）
- ✅ 树操作（增删移/防环/根保护）
- ✅ 布局（坐标/折叠/边界/深度）
- ✅ EventBus / UndoRedo / KeyboardShortcuts
- ✅ 估算高度 + 重布局检测

**缺失的测试覆盖**:
- ❌ YAML 序列化多行文本（P0-3 对应）
- ❌ 宽度测量管道（P0-1/P0-2 对应）
- ❌ MarkdownRenderer 渲染输出验证
- ❌ parentId 行号偏移场景（P0-4 对应）
- ❌ 大文件性能（100+ 节点）
- ❌ 编辑态 keydown 监听器泄漏（P1-2 对应）

---

## 建议的修复顺序

```
Phase 1 (P0 止血):
  1. P0-1: 宽度测量 — 临时 width:auto 测量法
  2. P0-2: 缓存命中补 el.style.width
  3. P0-3: YAML \n 转义
  4. P0-4: parentId 改用 heading-hash

Phase 2 (P1 体验):
  5. P1-1: saveFreeNodes debounce
  6. P1-2: keydown 监听器清理
  7. P1-3: vault.on('modify') 文件监听
  8. P1-4: 重布局检查宽度
  9. P1-5: 布局算法缓存 subtreeHeight
  10. P1-6: CSS flex 修复

Phase 3 (P2 清理):
  11. 逐项处理 P2 清单
```
