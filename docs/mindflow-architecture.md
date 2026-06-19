# MindFlow Architecture Reference

> MarkVault-JS 思维导图模块 — 架构设计文档
> 版本: v3.1 | 更新: 2026-06-19

---

## 目录

1. [系统概览](#1-系统概览)
2. [数据模型](#2-数据模型)
3. [渲染管线](#3-渲染管线)
4. [布局系统](#4-布局系统)
5. [数据层](#5-数据层)
6. [渲染层](#6-渲染层)
7. [事件与交互](#7-事件与交互)
8. [连线系统](#8-连线系统)
9. [Annotation 集成](#9-annotation-集成)
10. [全局数据流](#10-全局数据流)

---

## 1. 系统概览

### 1.1 定位

MindFlow 是 MarkVault 认知工作台中的**主动梳理工具**，与 RelationGraph（数据网络/看见关系，静态结果）互补。用户在导图中**组织过程产生新认知**，导图本身作为认知过程记录。

### 1.2 三种节点类型

| 类型 | 来源 | 可编辑 | 持久化 |
|------|------|--------|--------|
| `md-seed` | MD 正文解析 | 只读（detail 可编辑） | 文件正文 |
| `free` | 用户手动创建 | 全可编辑 | frontmatter |
| `annotation` | @A 标注引用 | 只读（标注内容不可改） | frontmatter |

### 1.3 八种布局类型

| 布局 | 适用场景 | 视觉特征 |
|------|---------|---------|
| `tree-right` | 通用思维导图 | 根左子右，层级展开 |
| `tree-left` | 反向思维导图 | 根右子左 |
| `org` | 组织架构 | 根顶子下，水平居中 |
| `logic-right` | 逻辑推导 | 同级紧凑，无子树堆叠 |
| `fishbone` | 因果关系 | 脊线+骨刺，方向交替 |
| `timeline` | 时间序列 | 主轴+事件，上下交替 |
| `radial` | 发散思考 | 中心放射，扇区分配 |
| `freeform` | 头脑风暴 | 自由排布，碰撞推开 |

### 1.4 六种认知结构类型

| 结构 | 默认布局 | 认知模式 |
|------|---------|---------|
| `flow` | tree-right | 流程/步骤 |
| `skeleton` | tree-right | 大纲骨架 |
| `hierarchy` | org | 层级关系 |
| `process` | logic-right | 过程推导 |
| `fishbone` | fishbone | 因果分析 |
| `freeform` | freeform | 自由发散 |

### 1.5 目录结构

```
src/mindflow/
├── types/mind-node.ts          # 数据模型定义 (206行)
├── view/mindflow-view.ts       # 主视图 (≈2500行)
├── data/
│   ├── md-parser.ts            # MD 正文解析
│   ├── seed-sync.ts            # 种子+用户节点同步
│   └── frontmatter-sync.ts     # frontmatter 读写
├── layout/
│   ├── layout-engine.ts        # 布局工厂路由
│   ├── tree-layout.ts          # tree-right/left/logic
│   ├── tree-org-layout.ts      # 组织结构图
│   ├── fishbone-layout.ts      # 鱼骨图
│   ├── timeline-layout.ts      # 时间轴
│   ├── radial-layout.ts        # 径向布局
│   └── freeform-layout.ts      # 自由布局
├── render/
│   ├── node-renderer.ts        # 节点 DOM 渲染
│   ├── svg-connector.ts        # SVG 连线
│   └── render-cache.ts         # 渲染缓存
└── core/
    ├── event-bus.ts            # 事件总线
    ├── keyboard-shortcuts.ts   # 键盘快捷键
    └── undo-redo.ts            # 撤销/重做
```

---

## 2. 数据模型

### 2.1 核心类型 `MindNode`

```typescript
interface MindNode {
  // ── 基本属性 ──
  id: string;                     // ID (md-前缀 / free-uuid / ann-uuid)
  parentId: string | null;        // 父节点 (根为 null)
  type: MindNodeType;             // 'md-seed' | 'free' | 'annotation'
  text: string;                   // 显示文本
  children: MindNode[];           // 子节点列表

  // ── 布局与状态 ──
  layout?: NodeLayout;            // 布局结果 {x, y, width, height}
  collapsed?: boolean;            // 折叠状态
  renderedHeight?: number;        // 实际渲染高度缓存
  renderedWidth?: number;         // 实际渲染宽度缓存

  // ── md-seed 专用 ──
  sourceLine?: number;            // 来源行号
  sourceLevel?: number;           // 标题/列表层级
  detail?: string;                // <!-- mf:detail --> 块内容

  // ── annotation 专用 ──
  annotationRef?: string;         // 批注 UUID
  annotationSummary?: string;     // 批注摘要

  // ── 连线语义 ──
  edgeLabel?: string;             // 与父节点的关系标签
  edgeNote?: string;              // 关系备注
  note?: string;                  // 节点备注
}
```

### 2.2 元数据 `MindmapMeta`

```typescript
interface MindmapMeta {
  structureType: StructureType;   // 认知结构类型
  layout?: LayoutType;            // 视觉布局
  boundaries?: BoundaryRecord[];  // 外框列表
  connections?: ConnectionRecord[]; // 自主连线列表
}

interface BoundaryRecord {
  id: string;      // 唯一 ID
  nodeIds: string[]; // 被框定的节点
  label: string;   // 自定义标签
  note?: string;   // 备注 (hover tooltip)
}

interface ConnectionRecord {
  id: string;      // 唯一 ID
  sourceId: string; // 起始节点
  targetId: string; // 目标节点
  label: string;   // 标签 (显示在连线上)
  note?: string;   // 备注
}
```

### 2.3 存储格式 (frontmatter)

```yaml
---
mindmap:
  structureType: skeleton
  layout: tree-right
  boundaries:
    - id: "boundary-xxx"
      label: "核心概念"
      note: "考试重点"
      nodeIds: [md-abc, free-xyz]
  connections:
    - id: "conn-xxx"
      sourceId: md-abc
      targetId: free-xyz
      label: "推导关系"
      note: "详见第三章"
  nodes:
    - id: "free-1"
      parentId: "md-abc"
      text: "补充说明"
      note: "个人理解"
    - id: "ann-uuid"
      parentId: "md-abc"
      text: "标注内容摘要"
      type: annotation
      annotationRef: "5ca3f0b1-a922-..."
      annotationSummary: "标注全生命周期"
      edgeLabel: "反例说明"
---
```

---

## 3. 渲染管线

### 3.1 `layoutAndRender()` — 4 步流程

```
Step 1: 占位布局 (同步)
  layoutTree(root, layoutType)
  → 根据 layout 类型路由到具体算法
  → 每个节点分配 .layout {x, y, width, height}
  → 使用估算尺寸 (estimateNodeWidth/Height)
  
  getVisibleNodes(root)         → 收集可见节点 (跳过折叠)
  getVisibleEdges(root)         → 收集父子连线边
  
  renderNodes(nodes, container) → 创建节点 DOM 骨架
  renderConnectors(edges, svg)  → 渲染树结构 SVG 连线
  bindNodeInteractions()        → 绑定点击/拖拽事件

Step 2: 异步渲染内容
  renderNodesContent(app, nodes, elements, ...)
  → 分批异步 (每批 10 个, rAF 隔帧)
  → MarkdownRenderer.render() → Obsidian MD 引擎
  → 测量实际 offsetHeight/Width
  → 缓存到 node.renderedHeight/Width
  → 返回 needsRelayout 列表

Step 3: 刷新公式
  finishRenderMath()
  → 处理 LaTeX/MathJax 渲染

Step 4: 重布局 (使用测量值)
  relayoutWithMeasured(root, layout)
  → 用 renderedHeight/Width 重算坐标
  → 更新 DOM 位置 (el.style.left/top/width/minHeight)
  → renderConnectors(edges, svg)      ← 重绘树连线
  → _renderRelationEdges()            ← 标注关系连线
  → _renderConnectionEdges()          ← 自主连线
  → renderBoundaries()                ← 外框
  → updateMinimap()                   ← 小地图
```

### 3.2 DOM 层级

```
containerEl (mindflow-view)
├── toolbarEl (mf-toolbar)
└── viewportEl (mf-viewport, overflow:hidden)
    └── canvasEl (mf-canvas, transform: pan/zoom)
        ├── svgEl (mf-connectors, z-index:0)
        │   └── 树结构贝塞尔连线 + edgeLabel
        ├── nodeLayerEl (z-index:1)
        │   ├── .mf-node--md-seed     (实线边框)
        │   ├── .mf-node--free        (紫色边框 + F角标)
        │   ├── .mf-node--annotation  (虚线边框 + A角标)
        │   └── .mf-boundary          (外框 div)
        └── _relSvgEl (z-index:10)
            ├── .mf-rel-edge          (标注关系连线)
            └── .mf-conn-edge         (自主连线)
```

---

## 4. 布局系统

### 4.1 工厂路由

```
layout-engine.ts — 布局路由器

layoutTree(root, 'tree-right')
  → tree-layout.ts → assignLayout(root, 40, 40, 'right')

relayoutWithMeasured(root, 'tree-right')
  → tree-layout.ts → assignLayout(root, ..., 'right')
     (使用 node.renderedHeight/renderedWidth 替代估算值)
```

### 4.2 布局算法对比

| 布局 | 核心算法 | 时间复杂度 | 碰撞处理 |
|------|---------|-----------|---------|
| tree-right | 自底向上子高度求和 → 自顶向下坐标分配 | O(N) | 预计算子树缓冲 |
| tree-left | 镜像 tree-right | O(N) | 同上 |
| org | 横向宽度计算 → 垂直分配 | O(N) | 预计算缓冲 |
| logic-right | 同列紧凑，独立子树空间 | O(N) | logicSubtreeHeight |
| fishbone | 脊线 + 交替方向 (横/竖/横/竖) | O(N) | 双向子树尺寸 |
| timeline | 主轴 + 等距事件 | O(N) | 上下交替 |
| radial | 叶节点权重扇区 + 环半径增长 | O(N) | 自适应角度 |
| freeform | 径向初排 + 随机偏移 + 碰撞推开 (5 轮) | O(N²) | 全局碰撞检测 |

### 4.3 尺寸估算

```
estimateNodeWidth: CJK字符 13px + ASCII 7px + padding 28px + border 4px
estimateNodeHeight: 行数 × 24px + padding 16px + 块级公式/代码块加成
getNodeHeight: 优先 renderedHeight → 回退 estimateNodeHeight
```

---

## 5. 数据层

### 5.1 解析流程: `syncFromMarkdown()`

```
.md 文件
  │
  ├─ parseMarkdownToNodes(content)
  │   ├─ 跳过 frontmatter (--- ... ---)
  │   ├─ 跳过代码块 (``` ... ```)
  │   ├─ 提取 detail 块 (<!-- mf:detail -->...<!-- /mf:detail -->)
  │   ├─ 标题 #/##/### → md-seed 节点
  │   ├─ 列表 -/* → md-seed 节点
  │   └─ 栈式树构建 → seedRoots
  │
  ├─ readMindmapConfig(content)
  │   └─ parseMindmapFrontmatter(content)
  │       ├─ structureType / layout
  │       ├─ boundaries[] → BoundaryRecord[]
  │       ├─ connections[] → ConnectionRecord[]
  │       └─ nodes[] → MindmapNodeRecord[]
  │
  └─ mergeFreeNodes(seedRoots, freeRecords)
      ├─ 构建 nodeIndex (ID → 节点)
      ├─ parentId 命中 → 挂载为子节点
      ├─ parentId 为 null → 顶层节点
      └─ parentId 失效 → 孤儿 + 顶层 + 告警
```

### 5.2 持久化: `writeMindmapConfig()`

```
MindFlowView.debouncedSave()
  └─ writeMindmapConfig(fileContent, meta, [root])
      ├─ extractFreeNodes([root]) → 仅 free + annotation
      └─ writeMindmapFrontmatter(content, meta, records)
          ├─ splitFile(content) → { frontmatter, body }
          ├─ serializeMindmap(meta, records) → YAML 段
          ├─ 替换或追加 mindmap: 段
          └─ joinFile(frontmatter, body) → 完整文件
```

### 5.3 树操作 API (`seed-sync.ts`)

| 函数 | 说明 |
|------|------|
| `findNode(root, id)` | 递归查找 |
| `findParent(root, id)` | 查找父节点 |
| `insertSibling(root, id, newNode)` | 在目标后插入 |
| `removeNode(root, id)` | 删除 (仅 free/annotation) |
| `moveNode(root, id, newParentId)` | 移动 (防环) |
| `getNodeIndex(root, id)` | 同级位置索引 |
| `getAncestors(root, id)` | 祖先链 |

---

## 6. 渲染层

### 6.1 节点渲染降级策略

```
renderNodeContent
  ├─ 检查 RenderCache (key: nodeId:djb2(text))
  │   └─ 命中 → 直接使用缓存 html
  ├─ MarkdownRenderer.render() ← Obsidian MD 引擎
  │   ├─ 成功 → 测量 → 写入缓存
  │   └─ 失败 → stripLatex()
  │       ├─ 成功 → 测量 → 写入缓存
  │       └─ 失败 → simpleMarkdownRender() ← 最终回退
  └─ 测量 (double rAF 确保排版完成)
      ├─ offsetHeight → node.renderedHeight
      └─ offsetWidth → node.renderedWidth
```

### 6.2 渲染缓存 (`RenderCache`)

| 属性 | 值 |
|------|-----|
| 缓存键 | `nodeId:djb2(node.text)` |
| 缓存值 | `{ html, height, width }` |
| 淘汰策略 | LRU, 最大 500 条 |
| 失效时机 | 文本变化 → hash 变化 → 缓存未命中 |

### 6.3 SVG 连线体系

```
┌─────────────────────────────────────────────────────────────┐
│ 三层 SVG 架构                                                │
│                                                             │
│   _relSvgEl (z-index:10) — 关系/自主连线层                   │
│   ├── .mf-rel-edge   — 标注关系连线                          │
│   │   ├── hitArea    (透明, 14px stroke, 拦截点击)            │
│   │   ├── path       (可见, 1.5px stroke, 纯装饰)             │
│   │   └── text       (关系类型标签)                           │
│   └── .mf-conn-edge  — 自主连线                              │
│       ├── hitArea    (透明, 14px stroke)                      │
│       ├── path       (可见, 2.5px stroke, 纯装饰)             │
│       └── text       (label 标签)                             │
│                                                             │
│   nodeLayerEl (z-index:1) — 节点 DOM 层                      │
│                                                             │
│   svgEl (z-index:0) — 树结构连线层                            │
│   └── .mf-connectors — 贝塞尔曲线                             │
│       ├── path       (实线/虚线, 2px)                         │
│       └── text       (edgeLabel 标签)                         │
└─────────────────────────────────────────────────────────────┘
```

### 6.4 连线视觉规范

| 连线类型 | 颜色 | 线宽 | 线型 | 透明度 | 箭头 |
|---------|------|------|------|--------|------|
| 树结构 (md-seed) | #7C8DA0 | 2px | 实线 | 1.0 | 无 |
| 树结构 (annotation) | #9CA3AF | 2px | 虚线 6 4 | 1.0 | 无 |
| 标注关系 (有效) | 按类型着色 | 1.5px | 圆点 2 6 | 0.55 | → |
| 标注关系 (失效) | #D0D0D0 | 1.5px | 圆点 2 6 | 0.55 | → |
| 自主连线 | #8B5CF6 | 2.5px | 长划线 10 4 | 0.65 | → |

**关系颜色映射**:
- `supports` → #43A047 (绿)
- `contradicts` → #E53935 (红)
- `extends` → #378ADD (蓝)
- `refines` → #8E24AA (紫)
- `explains` → #FB8C00 (橙)
- `relatedTo` → #9CA3AF (灰)

### 6.5 连线边界交点算法

```
连线端点从节点中心改为节点边界:

  rectBoundaryIntersection(rect, targetX, targetY):
    1. 计算节点中心 (cx, cy)
    2. 计算方向向量 (dx, dy) = (target - center)
    3. 与矩形四条边求交:
       - 水平边: t = hh / abs(dy)
       - 垂直边: t = hw / abs(dx)
       - 取 min(t) 为最近交点
    4. 返回 (cx + dx*t, cy + dy*t)
```

---

## 7. 事件与交互

### 7.1 事件总线 (`MindflowEventBus`)

| 通道 | 载荷 | 触发时机 |
|------|------|---------|
| `operation` | `OperationEvent` | 节点增删改移 |
| `collapse` | `CollapseEvent` | 折叠/展开 |
| `select` | `SelectEvent` | 节点选中/取消 |
| `view` | `ViewEvent` | 缩放/平移/适应 |

```
operation 事件 → debouncedSave()     # 500ms 防抖持久化
collapse 事件 → renderBoundaries()   # 边界框可能改变
```

### 7.2 键盘快捷键

| 按键 | 动作 | 说明 |
|------|------|------|
| Tab | insertChild | 添加子节点 |
| Enter | insertSibling | 添加兄弟节点 |
| F2 | editNode | 行内编辑 |
| Delete | deleteNode | 删除节点 |
| Space | toggleCollapse | 折叠/展开 |
| F1 | fitView | 适应视口 |
| Ctrl+Z | undo | 撤销 |
| Ctrl+Shift+Z | redo | 重做 |
| Arrow keys | navigate | 方向导航 |

### 7.3 撤销/重做 (`UndoRedoManager`)

```
快照结构:
{
  freeRecords: MindmapNodeRecord[]  // 用户节点快照 (深拷贝)
  boundaries: BoundaryRecord[]     // 外框快照
  connections: ConnectionRecord[]  // 连线快照
  collapsedStates: Record<string, boolean>  // 折叠状态
}

栈容量: 50 (最大)
redo 栈: 新操作后清空
```

### 7.4 Pan/Zoom

```
mousedown → isDragging = true → dragStart 记录起始位置
mousemove → (delta) → update panX/panY → applyTransform()
mouseup   → isDragging = false

wheel     → zoomAt(clientX, clientY, factor)
            factor: 上滚=1.1, 下滚=0.9
            scale: clamp(0.2, 3.0)
            
放行条件: .mf-node / .mf-rel-edge / .mf-conn-edge
          (这些元素上的 mousedown 不触发 pan)
```

---

## 8. 连线系统

### 8.1 三种连线对比

| 连线类型 | 数据来源 | 可编辑 | 可删除 | 左键 | 右键 |
|---------|---------|--------|--------|------|------|
| **树结构连线** | 节点父子关系 | edgeLabel | 否 (删节点即删边) | — | — |
| **标注关系连线** | annotationStore.relations | 否 (只读) | 软删除 (可恢复) | 详情 Modal | 删除/恢复 |
| **自主连线** | frontmatter.connections | label + note | 硬删除 (确认弹窗) | 编辑 label | 删除 |

### 8.2 父子连线标签 (edgeLabel)

```
使用场景: @A 标注节点等需要说明"为什么挂在这里"的节点

数据: MindNode.edgeLabel + MindNode.edgeNote
持久化: frontmatter nodes[] 中的 edgeLabel/edgeNote 字段
交互: 右键子节点 → "Add edge label" → 输入 label → 输入 note → 保存
渲染: 树结构连线中点显示 edgeLabel (灰色小字, 9px)
```

### 8.3 外框系统 (Boundary)

```
创建: 单选=同父所有兄弟, Shift多选=仅选中节点
渲染: nodeLayerEl 中的虚线矩形 div
标签: 左上角 "label (N)" 格式
删除: 右上角 × 按钮
编辑: 点击标签 → 编辑 label + note

frontmatter 格式:
  boundaries:
    - id: "boundary-xxx"
      label: "核心概念"
      note: "考试重点"
      nodeIds: [md-abc, free-xyz]
```

---

## 9. Annotation 集成

### 9.1 @A 节点创建

```
工具栏 '@A' 按钮
  → openAnnotationPicker()
    → 从 annotationStore 获取所有批注
    → AnnotationPickerModal (用户选择)
    → 创建 MindNode { type:'annotation', annotationRef, annotationSummary }
    → 挂载到选中父节点下
    → layoutAndRender()
```

### 9.2 标注关系连线

```
渲染位置: layoutAndRender() Step 4 → _renderRelationEdges()

数据收集:
  1. 遍历全树 → 收集所有 @A 节点 → annotationRef → nodeId 映射
  2. 对每对 @A 节点:
     store.getRelations(uuid, { includeInvalidated: true })
     → outgoing: source → target
     → incoming: source ← target
  3. 去重 → 构建 RelationEdge[]
  4. renderRelationEdges(rels, _relSvgEl, nodeElements, root, onMenu, onClick)

交互:
  - 左键 → RelationDetailModal (关系类型/源/目标/note/状态)
  - 右键 → ConfirmModal → invalidateRelation / restoreRelation
  - 失效关系: 淡灰色显示, 右键恢复
```

### 9.3 关系详情 Modal

```
┌─────────────────────────────────┐
│  Relation Detail                │
├─────────────────────────────────┤
│  Type:    [supports]            │  ← 彩色徽章
│  Status:  Active                │
│                                 │
│  Source Annotation              │
│    "标注全生命周期 (100%)"       │
│    UUID: 5ca3f0b1-a922…         │
│                                 │
│  Target Annotation              │
│    "3D标注是蓝海…"               │
│    UUID: 60220b19-ead3…         │
│                                 │
│  Note: 关系备注                  │
│                                 │
│  [Remove]              [Close]  │
└─────────────────────────────────┘
```

---

## 10. 全局数据流

### 10.1 从文件到渲染

```
┌──────────────────────────────────────────────────────────────┐
│                       .md 文件 (Vault)                        │
├──────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐   ┌──────────────────────────────┐     │
│  │   正文 (Markdown) │   │  frontmatter (YAML)          │     │
│  │  # 标题          │   │  mindmap:                    │     │
│  │  ### 子标题       │   │    structureType: skeleton   │     │
│  │  - 列表项        │   │    boundaries: [...]         │     │
│  │  <!-- mf:detail-->│  │    connections: [...]         │     │
│  └────────┬─────────┘   │    nodes: [...]              │     │
│           │              └─────────────┬────────────────┘     │
│           ▼                            ▼                      │
│  parseMarkdownToNodes    parseMindmapFrontmatter              │
│           │                            │                      │
│           └──────────┬─────────────────┘                      │
│                      ▼                                        │
│              syncFromMarkdown                                 │
│              ├─ mergeFreeNodes                                │
│              └─ ensureSingleRoot                              │
│                      │                                        │
└──────────────────────┼────────────────────────────────────────┘
                       ▼
              SeedSyncResult
              { root: MindNode, meta: MindmapMeta }
                       │
                       ▼
              MindFlowView.loadFromContent()
              ├─ this.rootNode = result.root
              ├─ this.meta = result.meta
              ├─ applyInitialExpandLevel(root, 2)
              └─ layoutAndRender()
                       │
                       ▼
              ┌─────────────────────────────┐
              │      4 步渲染管线            │
              │  Step 1: 占位布局 (同步)     │
              │  Step 2: 异步渲染内容        │
              │  Step 3: 刷新公式            │
              │  Step 4: 重布局 + 连线       │
              └─────────────────────────────┘
                       │
                       ▼
              用户交互 (键盘/鼠标/右键菜单)
                       │
                       ▼
              eventBus.emit('operation')
                       │
                       ▼
              debouncedSave() (500ms)
                       │
                       ▼
              writeMindmapConfig()
              └─ .md 文件更新
```

### 10.2 关键常量

| 常量 | 值 | 说明 |
|------|-----|------|
| DEFAULT_EXPAND_LEVEL | 2 | 默认展开层级 (根+两层) |
| DEFAULT_STRUCTURE_TYPE | 'skeleton' | 默认认知结构 |
| DEFAULT_LAYOUT_TYPE | 'tree-right' | 默认视觉布局 |
| HORIZONTAL_GAP | 220 | 兄弟节点水平间距 |
| VERTICAL_GAP | 28 | 父子节点垂直间距 |
| SUBTREE_EXTRA_GAP | 16 | 子树额外缓冲 |
| DEFAULT_STROKE | #7C8DA0 | 树连线颜色 |
| CONN_COLOR | #8B5CF6 | 自主连线颜色 |
| REL_STROKE_WIDTH | 1.5px | 关系连线宽度 |
| CONN_STROKE_WIDTH | 2.5px | 自主连线宽度 |
| RenderCache MAX_SIZE | 500 | 渲染缓存上限 |
| UndoRedo MAX_STACK | 50 | 撤销栈上限 |
| Save DEBOUNCE | 500ms | 保存防抖间隔 |

### 10.3 架构模式总结

| 模式 | 应用 |
|------|------|
| 工厂路由 | 布局引擎根据 LayoutType 分发到 8 种算法 |
| 两遍布局 | 估算 → 渲染 → 测量 → 重布局 (实际值) |
| 事件总线解耦 | 操作 → eventBus → 持久化/UI 更新 |
| 快照式撤销 | 操作前深拷贝状态 |
| 双源合一 | MD-Seed (正文) + Free/Annotation (frontmatter) |
| 渲染缓存 | text hash → html 缓存, LRU 淘汰 |
| 代次计数器 | 防多视图异步竞态 |
| SVG 图层分离 | 树连线层(底) + 节点层 + 关系层(顶) |
| 轻量 YAML | 自实现解析/序列化, 不依赖第三方库 |
| 防抖保存 | 操作事件 → 500ms → 写入磁盘 |
| 隐形点击面 | 透明 14px stroke path 提高连线命中率 |
| 边界交点 | rect-intersection 算法使连线不穿透节点文字 |
