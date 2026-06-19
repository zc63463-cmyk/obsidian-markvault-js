# MindFlow 深度审查 V2 — 修复后状态 + 标注架构就绪度评估

> 审查日期: 2026-06-18 23:15 | 基线: P0(4)+P1(6)+P2(9) 全部修复后

## 一、修复后残留问题审查

### 新发现问题

| # | 严重度 | 文件 | 问题 | 状态 |
|---|--------|------|------|------|
| N1 | **P1** | `mindflow-view.ts:326-340` | `resync()` 调用 `applyInitialExpandLevel(root, 2)` 会重置用户手动展开/折叠状态——外部编辑 .md 触发 resync 后，用户已展开的深层节点被折叠 | 需修复 |
| N2 | **P1** | `mindflow-view.ts:179` | `vault.on('modify')` 监听会在 MindFlow 自身 `saveFreeNodes()` 写文件时触发 → resync → 可能覆盖正在编辑的 Free 节点。需要区分"外部修改"和"自身保存" | 需修复 |
| N3 | **P2** | `mindflow-view.ts:218` | `_editKeydownHandler` 在 `onClose` 中未清理。如果视图在编辑态被关闭，keydown 监听器可能泄漏 | 低风险 |
| N4 | **P2** | `node-renderer.ts:213-221` | `finally` 块的防御性恢复逻辑有缺陷：`savedWidth` 可能是 `'auto'`（上次渲染失败未恢复），导致 `el.style.width === savedWidth` 永远 true | 低风险 |
| N5 | **P2** | `frontmatter-sync.ts:154` | `parseMindmapFrontmatter` 中 `kvMatch[2].replace(/^["']|["']$/g, '')` 对顶层字段（structureType/layout）仍用旧的去引号逻辑，不走 P0-3 的反转义路径 | 低风险 |

### 已修复确认

| 原问题 | 状态 |
|--------|------|
| P0-1 宽度循环依赖 | ✅ `width:auto` 测量法 |
| P0-2 缓存不更新DOM | ✅ 缓存分支设 `el.style.width` |
| P0-3 YAML换行损坏 | ✅ `\n\r\t` 转义 + 反转义 |
| P0-4 parentId行号 | ✅ `md-{hash(text)}` |
| P1-1 防抖 | ✅ 500ms debounce |
| P1-2 监听器泄漏 | ✅ removeEventListener |
| P1-3 文件监听 | ✅ vault.on('modify') — **但有 N2 问题** |
| P1-5 O(N²) | ✅ precomputeSubtreeHeights |
| P2-2 缓存碰撞 | ✅ djb2 完整哈希 |
| P2-3 Undo折叠态 | ✅ collapsedStates |
| P2-8 自适应间距 | ✅ nodeWidth + 40px |

---

## 二、标注功能架构就绪度评估

### 2.1 设计规划回顾

根据 MEMORY.md 和设计文档，Phase 3 标注集成需要：

1. **annotation 节点类型** — 导图中引用已有标注
2. **MindmapSelector** — 标注可以标注导图节点本身
3. **byAnnotationRef 反向索引** — 标注被哪些导图引用
4. **byNodeId 索引** — 导图节点被哪些标注引用
5. **三种交互模式**:
   - ①纯导图（独立）— 当前已实现
   - ②@引用标注 — 导图节点引用已有标注
   - ③导图节点被标注 — text=节点内容, note=认知描述

### 2.2 当前架构逐层评估

#### ✅ 数据层 — 已就绪

| 组件 | 状态 | 说明 |
|------|------|------|
| `MindNodeType` | ✅ 已预留 `'annotation'` | `types/mind-node.ts:14` |
| `annotationRef` 字段 | ✅ 已预留 | `types/mind-node.ts:63` |
| `annotationSummary` 字段 | ✅ 已预留 | `types/mind-node.ts:65` |
| `MindmapSelector` | ✅ 已定义 | `types/annotation.ts:96-102` |
| `Annotation.docType='mindmap'` | ✅ 已定义 | `types/annotation.ts:164` |
| `Annotation.nodeId` | ✅ 已定义 | `types/annotation.ts:168` |
| `byAnnotationRef` 索引 | ✅ 已实现 | `db/index-layer.ts:67` |
| `byNodeId` 索引 | ✅ 已实现 | `db/index-layer.ts:64` |
| `byDocType` 索引 | ✅ 已实现 | `db/index-layer.ts:61` |

#### ⚠️ 持久化层 — 需要扩展

| 组件 | 状态 | 问题 |
|------|------|------|
| `FreeNodeRecord` | ⚠️ 缺少 annotation 字段 | 需添加 `annotationRef` / `annotationSummary` |
| `toFreeNodeRecord` | ⚠️ 不处理 annotation 类型 | `extractFreeNodes` 只提取 `type==='free'`，annotation 节点不会被保存 |
| `fromFreeNodeRecord` | ⚠️ 硬编码 `type:'free'` | 需改为接受 type 参数或创建独立 record 类型 |
| `yamlString` | ✅ P0-3 已修复 | 换行/特殊字符正确转义 |
| `setNodeField` | ✅ P0-3 已修复 | 反转义逻辑就绪 |

**需要做**:
```typescript
// 方案: 扩展 FreeNodeRecord 为 MindmapNodeRecord
interface MindmapNodeRecord {
  id: string;
  parentId: string | null;
  text: string;
  type: 'free' | 'annotation';  // 新增
  note?: string;
  collapsed?: boolean;
  annotationRef?: string;       // 新增
  annotationSummary?: string;   // 新增
}
```

#### ⚠️ 解析层 — 需要扩展

| 组件 | 状态 | 问题 |
|------|------|------|
| `md-parser.ts` | ✅ 无需改动 | MD-Seed 不涉及标注 |
| `mergeFreeNodes` | ⚠️ 只处理 Free 节点 | 需改为也处理 annotation 节点 |
| `extractFreeNodes` | ⚠️ 过滤条件 `type==='free'` | 需改为 `type==='free' \|\| type==='annotation'` |

#### ✅ 布局层 — 已就绪

| 组件 | 状态 | 说明 |
|------|------|------|
| `tree-layout.ts` | ✅ 类型无关 | 布局算法只看 `children`/`collapsed`/`renderedHeight` |
| `estimateNodeWidth/Height` | ✅ 类型无关 | 估算基于 text 内容 |
| `precomputeSubtreeHeights` | ✅ 类型无关 | — |

#### ⚠️ 渲染层 — 需要扩展

| 组件 | 状态 | 问题 |
|------|------|------|
| `renderNode` | ✅ 已预留 annotation badge | `node-renderer.ts:63-68` |
| `renderNodeContent` | ⚠️ 不处理 annotation 节点 | annotation 节点 text 应来自标注原文，需特殊渲染逻辑 |
| CSS `.mf-node--annotation` | ✅ 已预留 | `styles.css:3301-3304` 虚线边框 |
| `svg-connector.ts` | ✅ annotation 连线已处理 | `svg-connector.ts:105` 虚线 |

#### 🔴 视图层 — 需要大量开发

| 组件 | 状态 | 问题 |
|------|------|------|
| `enterEditMode` | 🔴 硬编码只允许 free 类型 | `mindflow-view.ts:823: if (node.type === 'md-seed') return` — annotation 也应只读 |
| `handleInsertChild` | 🔴 只创建 free 节点 | 需新增"插入标注引用"操作 |
| `handleDeleteNode` | 🔴 只允许删除 free | 需允许删除 annotation 引用 |
| 标注引用 UI | 🔴 不存在 | 需要: 选择标注 → 创建 annotation 节点 → 挂载到树 |
| 标注反向跳转 | 🔴 不存在 | 点击 annotation 节点 → 跳转到标注原文位置 |
| 标注同步 | 🔴 不存在 | 标注被删除/修改时 → 导图中对应节点更新/移除 |

#### ⚠️ 事件系统 — 基本就绪

| 组件 | 状态 | 说明 |
|------|------|------|
| EventBus | ✅ 4通道 | 可扩展新增 `'annotation'` 通道 |
| UndoRedo | ⚠️ 只快照 Free 节点 | 需改为也快照 annotation 节点 |
| KeyboardShortcuts | ✅ 无需改动 | — |

### 2.3 就绪度总结

```
┌─────────────────────────────────────────────────────────────┐
│                    标注功能就绪度                             │
├──────────────┬──────┬───────────────────────────────────────┤
│  层          │ 评分 │ 说明                                  │
├──────────────┼──────┼───────────────────────────────────────┤
│ 数据类型定义  │ 95%  │ 几乎全部预留，仅需扩展 Record          │
│ 持久化层     │ 50%  │ FreeNodeRecord 需升级为通用 Record    │
│ 解析层       │ 60%  │ mergeFreeNodes/extract 需泛化         │
│ 布局层       │ 100% │ 完全类型无关                          │
│ 渲染层       │ 70%  │ 骨架+CSS 已预留，内容渲染需扩展        │
│ 视图层       │ 20%  │ 需新增: 标注选择/引用/跳转/同步       │
│ 事件系统     │ 85%  │ EventBus 就绪，UndoRedo 需泛化        │
│ DB 索引层    │ 100% │ byAnnotationRef/byNodeId 已实现       │
├──────────────┼──────┼───────────────────────────────────────┤
│ 总体就绪度   │ ~65% │ 数据层优秀，视图层是主要工作量         │
└──────────────┴──────┴───────────────────────────────────────┘
```

### 2.4 Phase 3 开发建议

#### 优先级排序

| 优先级 | 任务 | 依赖 | 工作量 |
|--------|------|------|--------|
| **P0** | 扩展 FreeNodeRecord → MindmapNodeRecord | 无 | 小 |
| **P0** | `extractFreeNodes` 改为 `extractUserNodes` (free + annotation) | 上 | 小 |
| **P0** | `mergeFreeNodes` 改为 `mergeUserNodes` | 上 | 小 |
| **P0** | `enterEditMode` 改为 `type !== 'md-seed'` → `type === 'free'` | 无 | 极小 |
| **P1** | 标注引用选择器 UI（Modal: 搜索+选择标注 → 创建 annotation 节点） | P0 | 中 |
| **P1** | annotation 节点内容渲染（显示标注原文摘要 + 来源链接） | P0 | 中 |
| **P1** | 点击 annotation 节点 → 跳转到标注原文（打开对应文件+定位） | P1 | 中 |
| **P2** | 标注删除 → 导图同步移除 annotation 节点 | P1 | 中 |
| **P2** | 导图节点被标注（模式③）— 标注的 selector.nodeId 指向导图节点 | P1 | 大 |
| **P2** | UndoRedo 快照泛化（包含 annotation 节点） | P0 | 小 |

#### 架构风险

1. **N1+N2 循环触发风险**: resync 重置折叠态 + 自身保存触发 modify 监听 → 必须在进入 Phase 3 前修复
2. **MindNode.id 稳定性**: annotation 节点用 `ann-{uuid}` 前缀，与 free 的 `uuid` 格式不同。需确认 `byNodeId` 索引能正确匹配
3. **标注原文同步**: 标注被编辑后，导图节点 `annotationSummary` 缓存可能过期。需要监听标注变更事件

---

## 三、建议的下一步

### 立即修复（进入 Phase 3 前）

1. **N1**: `resync()` 保存/恢复 collapsed 状态
2. **N2**: `saveFreeNodes()` 写文件时设置 `_isSelfSaving` flag，modify 监听跳过
3. **N3**: `onClose` 中清理 `_editKeydownHandler`

### Phase 3 开发顺序

```
Step 1: 持久化层泛化 (MindmapNodeRecord + extract/merge)
Step 2: enterEditMode 权限修正
Step 3: 标注引用选择器 Modal
Step 4: annotation 节点渲染
Step 5: 点击跳转
Step 6: 标注变更同步
Step 7: 模式③（导图节点被标注）
```
