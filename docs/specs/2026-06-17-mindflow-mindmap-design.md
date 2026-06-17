# MindFlow v3.0 — Obsidian 思维导图插件设计文档

> 版本: v3.0 | 日期: 2026-06-17 | 状态: DRAFT
>
> v3.0 变更：整合路径2标注模型（docType统一扩展）、方案B文本标注（锚点+背景色分离）、选框标注复用PDF基础设施

## 1. 概述

**MindFlow** 是 MarkVault-JS 的思维导图子模块，独立创建思维导图，以 .md 文件标题/列表作为初始骨架，支持 MarkVault 标注系统全链路接入。

### 1.1 核心定位

1. **独立创建**思维导图 — 不是把当前文件映射成导图，而是独立 .md 文件
2. **MD 骨架种子** — .md 标题/列表作为只读初始骨架，用户自由扩展
3. **标注系统全链路接入** — 批注作为子节点 + 导图文本标注 + 选框标注，统一 docType 扩展模型
4. **数据层统一，渲染层分离** — 同一 Annotation 对象，编辑器/导图/PDF 各自最优渲染

### 1.2 四大差异化卖点

| # | 卖点 | 竞品对比 | 护城河 |
|---|------|---------|--------|
| 1 | **节点内 MD 实时渲染** | 全部竞品用纯文本或 Quill | ★★★★★ 强 — 无竞品实现 |
| 2 | **标注系统全链路接入** | MarkMind 有 PDF 联动（闭源），无导图标注 | ★★★★★ 强 — 独家认知数据 |
| 3 | **导图文本标注（方案B）** | 无竞品支持在导图内标注 | ★★★★☆ 中强 — 复用锚点 |
| 4 | **语义视觉增强** | 无竞品有认知语义着色 | ★★★★☆ 中强 — 复用 MarkVault |

### 1.3 技术方案：DOM-Flow

选择 DOM 节点 + SVG 连线 + CSS 弹性布局，而非 Canvas 或 WebGL：

| 优势 | 说明 |
|------|------|
| 节点即 DOM | contentEditable 编辑零摩擦，MD 渲染零桥接 |
| SVG 连线 | 样式化（虚线/颜色/箭头/曲率），复用 MarkVault computeCurvature |
| CSS 动画 | 折叠/展开/布局切换 transition，无需动画引擎 |
| 标注渲染 | 方案B天然适配：锚点在 DOM 中，背景色在 CSS 中 |

性能目标：500 节点内流畅（超出时虚拟化滚动）。

---

## 2. 数据模型

### 2.1 三种节点类型

| 类型 | 来源 | MD 同步 | 存储 | 视觉区分 |
|------|------|---------|------|---------|
| **MD-Seed** | .md 标题/列表 | 单向映射（只读种子） | .md 正文 | 实线边框，普通样式 |
| **Free** | 用户在导图中手动创建 | 不同步回 MD | frontmatter JSON | 实线边框，右上角 "F" 角标 |
| **Annotation** | 从 MarkVault 拖入/标注创建 | docType='mindmap' 标注 | MarkVault Store | 虚线边框，左上角批注图标 |

### 2.2 MindNode 数据结构

```typescript
interface MindNode {
  id: string;              // UUID
  filePath: string;        // 所属 .md 文件路径
  type: 'root' | 'branch' | 'leaf' | 'free' | 'annotation';

  // ─── 文本内容 ─────────────────────────
  text: string;            // MD 原始文本（未渲染）
  richText?: string;       // 渲染后 HTML（缓存）

  // ─── MD-Seed 定位 ─────────────────────
  mdSource?: {
    startLine: number;
    endLine?: number;
    startOffset: number;
    endOffset: number;
  };

  // ─── 自由节点 ─────────────────────────
  isFree?: boolean;

  // ─── 批注引用（Annotation 子节点） ────
  annotationRef?: string;       // MarkVault 批注 UUID
  annotationSummary?: string;   // 摘要缓存
  annotationFilePath?: string;   // 批注源文件路径

  // ─── 树结构 ───────────────────────────
  parentId: string | null;
  childrenIds: string[];
  level: number;

  // ─── 视觉状态（运行时） ──────────────
  collapsed?: boolean;
  layoutX?: number;
  layoutY?: number;

  // ─── v3.0: 标注覆盖信息（运行时，从 AnnotationStore 读取） ──
  annotationOverlay?: AnnotationOverlay;
}

/** 节点上的标注覆盖信息（运行时渲染用，不持久化到 frontmatter） */
interface AnnotationOverlay {
  color?: string;             // annotation.color → 节点背景色
  motivation?: string;        // → 节点边框色（语义调色板）
  hasNote?: boolean;          // → 笔记图标
  flags?: Partial<AnnotationFlag>; // → 学习状态视觉
}
```

### 2.3 .md 文件存储格式

```markdown
---
mindmap:
  layout: tree-right
  nodes:
    - id: n3
      parentId: n1
      annotationRef: "uuid-abc-123"
      annotationSummary: "关键定义：x 是 y 的推广形式"
      annotationFilePath: "Notes/数学/线性代数.md"
    - id: n5
      parentId: n2
      isFree: true
      text: "补充说明：与概率论的联系"
---

# 学习计划

## 核心概念

- 向量空间
- 线%%mv:i:a1b2:bold:yellow%%**性代数**的核心概念
- 特征值

## 应用场景

- 数据压缩
- 图像处理
```

**存储规则：**
- `.md` 正文（标题+列表）→ MD-Seed 节点，只读种子
- `%%mv:i%%` 锚点 → MarkVault 标注数据，同一 Annotation 对象
- frontmatter `mindmap.nodes` → Free 节点 + Annotation 节点元数据
- 编辑 MD-Seed 节点 → 同步修改 .md 正文
- 编辑 Free/Annotation 节点 → 同步修改 frontmatter
- .md 正文编辑 → 重新解析标题/列表 → 更新 MD-Seed 节点（单向）

---

## 3. 标注系统全链路接入（v3.0 核心）

### 3.1 docType 统一扩展模型

MarkVault 的 Annotation 模型通过 `docType` 字段区分文档类型，三种 docType 共享认知数据层：

```
┌─────────────────────────────────────────────────────┐
│                  认知数据层 (100% 复用)               │
│  tags / fields / groups / flags / motivation /       │
│  relations / note / alias                             │
├──────────────┬──────────────┬────────────────────────┤
│  docType:    │  docType:    │  docType:              │
│  'markdown'  │  'pdf'       │  'mindmap'             │
│              │              │                         │
│  Selector:   │  Selector:   │  Selector:             │
│  startOffset │  pdfSelector │  mindmapSelector        │
│  endOffset   │  {page,      │  {filePath,            │
│  startLine   │   selection, │   nodeId,              │
│  endLine     │   rect}      │   type}                │
├──────────────┼──────────────┼────────────────────────┤
│  渲染:       │  渲染:       │  渲染:                 │
│  CM6 Deco    │  SVG Overlay │  节点背景色+边框        │
│  <mark>/<b>  │  + 矩形/路径 │  + MD inline 渲染      │
└──────────────┴──────────────┴────────────────────────┘
```

**核心原则**：数据层统一（同一个 Annotation 对象可以在三种文档之间建立 relations），渲染层各自最优。

### 3.2 mindmapSelector 定义

```typescript
interface MindmapSelector {
  filePath: string;           // 导图 .md 文件路径
  nodeId: string;             // 目标节点 ID
  type: 'node' | 'group';    // 单节点标注 | 选框标注
  nodeIds?: string[];         // 选框标注时：包围的节点 ID 列表
}
```

与 pdfSelector 的对比：

| 维度 | pdfSelector | mindmapSelector |
|------|-------------|-----------------|
| 页面定位 | `page: number` | `nodeId: string` |
| 文本定位 | `selection: {4 int}` | 无字符偏移（整节点标注） |
| 区域定位 | `rect: {x,y,w,h}` | `nodeIds: string[]`（选框） |
| 坐标稳定性 | 固定（PDF 页面不变） | 固定（nodeId 不变，MD 锚点隐含定位） |
| 漂移恢复 | 不需要 | 不需要（锚点在 MD 源中，零漂移） |

### 3.3 导图文本标注 — 方案B（锚点+背景色分离）

**核心设计**：标注信息的数据层和渲染层分离。

| 层 | 数据 | 渲染 |
|---|------|------|
| **锚点** | `%%mv:i:uuid:bold:yellow%%` 插入 .md 正文 | 编辑器视图：CM6 decoration → 粗体+底色 |
| **颜色** | `annotation.color = 'yellow'` | 导图视图：节点背景色 `rgba(250,204,21,0.15)` |
| **语义** | `annotation.motivation` | 导图视图：节点边框色（语义调色板） |

**三种视图一致渲染**：

```
.md 源文件:
  - 线%%mv:i:a1b2:bold:yellow%%**性代数**的核心概念

┌─────────────────────────────────────────────────────┐
│ 编辑器视图 (CM6)                                    │
│  ─ 线[b class="mv-yellow"]性代数[/b]的核心概念      │
│    → 粗体文字 + 黄色底色 (MarkVault 现有能力)        │
├─────────────────────────────────────────────────────┤
│ 导图视图 (DOM)                                      │
│  ┌────────────────────────────┐                    │
│  │  线 性代数 的核心概念        │ ← 背景色: rgba(250,204,21,0.15) │
│  │  (粗体"性代数")             │ ← 边框色: motivation语义色     │
│  └────────────────────────────┘                    │
│  → "性代数"粗体渲染(MD inline) + 整节点背景色       │
├─────────────────────────────────────────────────────┤
│ PDF 视图 (如果导出为PDF)                            │
│  → 不适用（思维导图不导出为PDF标注）                 │
└─────────────────────────────────────────────────────┘
```

**关键优势**：

1. **零漂移** — 锚点在 .md 源中，不管节点怎么拖拽/折叠/重排，锚点位置跟着 MD 源走
2. **双视图一致** — 同一个 Annotation 对象，编辑器看底色，导图看背景色，数据完全一致
3. **零额外渲染引擎** — 不需要在 contentEditable DOM 内做字符级背景色，只需节点级 CSS
4. **支持无背景** — `color=null` → 只有粗体锚点标记，无底色/背景色，干净清爽

**标注创建流程**：

```
1. 导图中选中节点 → 右键 "标注此节点"
2. MindFlow 调用 MarkVault API:
   - 创建 Annotation 对象:
     { docType: 'mindmap', mindmapSelector: {filePath, nodeId, type: 'node'}, color: 'yellow', ... }
   - 在 .md 源文件对应行插入 %%mv:i%% 锚点 + 粗体包裹
3. 编辑器视图 → CM6 自动渲染锚点 (MarkVault 现有能力)
4. 导图视图 → MindFlow 从 AnnotationStore 读取:
   - annotation.color → 节点背景色
   - annotation.motivation → 节点边框色
   - 锚点位置 → MD inline 渲染粗体
```

### 3.4 选框标注（复用 PDF 基础设施）

**类似 XMind 摘要，但纳入标注系统**：框选多个分支节点 → 创建选框标注 → 拥有 tags/flags/motivation/relations 全部认知数据。

**复用 PDF 的 docType 路由机制**：

| PDF 扩展已建 | MindFlow 复用 |
|-------------|--------------|
| `docType` 字段路由 | `docType: 'mindmap'` 直接注册 |
| Selector 注册机制 | `mindmapSelector` 注册为新 Selector 类型 |
| 按类型查询索引 | `byDocType['mindmap']` 自动可用 |
| Annotation CRUD | 选框标注走同一个 AnnotationStore |
| 关系引擎 | 选框标注可与其他标注建立 relations |
| W3C 兼容层 | mindmapSelector → W3C FragmentSelector + SvgSelector |

**选框标注数据模型**：

```typescript
// 选框标注 — 与 PDF 矩形区域标注完全同构
{
  uuid: "sel-001",
  filePath: "Notes/学习计划.md",
  docType: "mindmap",
  kind: "region",
  type: "highlight",
  color: "purple",
  mindmapSelector: {
    filePath: "Notes/学习计划.md",
    nodeId: "group-1",          // 选框自身 ID
    type: "group",
    nodeIds: ["n3", "n4", "n5"] // 被框选的节点
  },
  text: "核心概念 + 两个分支",
  note: "这三个概念构成了线性代数的核心框架",
  tags: ["ch1", "exam_topics"],
  motivation: "classifying",
  // ... 全部认知字段复用
}
```

**选框渲染**：

```
导图视图:
  ┌─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐  ← SVG 虚线矩形（mindmapSelector.color 色）
  │                              │
  │   ┌──────────┐               │
  │   │ 核心概念  │               │
  │   └────┬─────┘               │
  │    ┌───┴───┐                 │
  │    │       │                 │
  │  ┌─┴──┐ ┌─┴──┐              │
  │  │向量│ │映射│              │
  │  └────┘ └────┘              │
  │                              │
  │  📝 三个概念构成核心框架       │  ← 选框标注 note 显示
  └─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘

编辑器视图:
  → 对应 region 高亮（MarkVault 现有 region 标注能力）
```

**选框与 PDF 区域标注的对比**：

| 维度 | PDF 区域标注 | 思维导图选框标注 |
|------|-------------|----------------|
| 定位 | `rect: {x,y,w,h}` 归一化坐标 | `nodeIds: [...]` 节点 ID 列表 |
| 渲染 | SVG 矩形叠加在 PDF 上 | SVG 虚线矩形包围节点 |
| 位置稳定性 | 固定（PDF 页面不变） | 动态（节点移动→选框自动跟随） |
| 漂移恢复 | 不需要 | 不需要（nodeId 不变） |
| 关系系统 | ✅ 完全可用 | ✅ 完全可用 |
| 认知数据 | ✅ 完全可用 | ✅ 完全可用 |

---

## 4. 视图架构（四层分离）

### 4.1 架构全景

```
┌─────────────────────────────────────────────────────┐
│ L4 Theme Layer                                      │
│  CSS Variables / Semantic Palette / Animation /     │
│  Dark-Light / Layout Transitions                    │
├─────────────────────────────────────────────────────┤
│ L3 Node Renderer                                    │
│  MD Inline Renderer / Node Type Styler /            │
│  Annotation Renderer / ContentEditable /            │
│  Annotation Overlay (背景色+边框色) /                │
│  Group Box Renderer (选框)                           │
├─────────────────────────────────────────────────────┤
│ L2 Layout Engine                                    │
│  Tree Layout / Radial Layout / Org Layout /         │
│  Fishbone Layout / SVG Connector / Pan-Zoom /       │
│  Virtual Scroll / Group Box Bounds (选框包围计算)    │
├─────────────────────────────────────────────────────┤
│ L1 Data Sync                                        │
│  MD Parser / Frontmatter Sync / Seed Sync /         │
│  MarkVault Bridge / Annotation Overlay Sync /       │
│  Group Annotation Sync / Undo-Redo                  │
└─────────────────────────────────────────────────────┘
```

### 4.2 L1 Data Sync 组件

| 组件 | 职责 | 关键接口 |
|------|------|---------|
| MD Parser | 标题/列表 → MindNode 树 | `parseToNodes(content): MindNode[]` |
| Frontmatter Sync | 读写 frontmatter 中 Free/Annotation 节点 | `readNodes()/writeNodes()` |
| Seed Sync | MD-Seed 单向映射 | `onVaultModify()` → Diff → 增量更新 |
| MarkVault Bridge | 读取 AnnotationStore，获取标注数据 | `getAnnotation()/onAnnotationChange()` |
| Annotation Overlay Sync | 扫描节点标注 → 计算覆盖信息 | `computeOverlays(nodes): Map<nodeId, Overlay>` |
| Group Annotation Sync | 选框标注 → SVG 包围矩形计算 | `computeGroupBox(annotations): Bounds[]` |
| Undo-Redo | 操作历史栈 | 基于 Obsidian Editor 原生 undo/redo |

### 4.3 L3 Node Renderer 组件

| 组件 | 职责 |
|------|------|
| MD Inline Renderer | `**b**` / `` `c` `` / `$L$` / `[[w]]` → 渲染富文本 |
| Node Type Styler | 三种节点类型视觉区分（实线/虚线/角标） |
| Annotation Renderer | Annotation 子节点渲染（摘要+批注图标+tags徽章） |
| Annotation Overlay | 标注覆盖渲染：`annotation.color` → 节点背景色，`motivation` → 边框色 |
| ContentEditable | focus → 源码模式，blur → 渲染模式 |
| Group Box Renderer | 选框标注：SVG 虚线矩形 + note 文本 |

---

## 5. 节点内 Markdown 实时渲染

### 5.1 支持的行内语法

| 语法 | 渲染效果 | 实现方式 |
|------|---------|---------|
| `**bold**` | **粗体** | `<strong>` |
| `*italic*` | *斜体* | `<em>` |
| `` `code` `` | `代码` | `<code>` |
| `$LaTeX$` | KaTeX 渲染 | `katex.renderToString()` |
| `[[wiki link]]` | 可点击链接 | `<a>` + Obsidian openLinkText |
| `[text](url)` | 超链接 | `<a>` |
| `==highlight==` | 高亮 | `<mark>` |
| `~~strikethrough~~` | 删除线 | `<del>` |

### 5.2 编辑态切换

```
展示态 (默认)                    编辑态 (focus)
┌───────────────┐               ┌───────────────┐
│ **粗体** `代码` │  ──click──▶  │ **粗体** `代码` │
│ $E=mc^2$      │               │ $E=mc^2$      │
│ [[链接]]       │               │ [[链接]]       │
└───────────────┘               └───────────────┘
  (渲染后的HTML)                   (MD源码，可编辑)
       │                               │
       │         blur/Ctrl+Enter       │
       │◀─────────────────────────────│
       │        解析MD → 渲染HTML      │
       │        同步存储               │
```

### 5.3 自研轻量 MD Inline Renderer

不引入 ProseMirror/CodeMirror（太重），自研基于正则的 inline parser：
- 分词：将文本拆分为 text / bold / italic / code / latex / link 片段
- 渲染：每个片段映射到对应 HTML 标签
- LaTeX：异步渲染，先占位后替换
- 安全：XSS 过滤，禁止 `<script>` / `<iframe>`

### 5.4 标注锚点在 MD 渲染中的处理

`%%mv:i:uuid:bold:yellow%%` 锚点在导图视图中**隐身**（不显示），但其包裹的 `**粗体**` 正常渲染：

```
MD 源码: 线%%mv:i:a1b2:bold:yellow%%**性代数**的核心概念
         ↓ MD Inline Renderer 处理
展示态:  线 性代数 的核心概念  (性代数 = 粗体)
         + 节点背景色 = yellow (来自 annotationOverlay)
```

---

## 6. 批注-导图联动 (MarkVault Bridge)

### 6.1 三层联动架构

| 层级 | 联动方式 | 数据流 |
|------|---------|--------|
| **L1: 批注作为子节点** | MarkVault 批注 → 导图中 Annotation 子节点 | 读取 AnnotationStore → 创建 Annotation MindNode |
| **L2: 节点文本标注** | 导图节点 → MarkVault 标注（方案B） | 创建 Annotation(docType='mindmap') + 插入锚点 |
| **L3: 选框标注** | 多节点框选 → MarkVault region 标注 | 创建 Annotation(docType='mindmap', kind='region') |

### 6.2 批注作为子节点

批注不是附着的 Badge，而是**完整的子节点**，挂载到导图任意节点下。

```
用户操作:
  MarkVault 侧栏选中批注 → 拖入导图 / 右键"添加批注到导图"
       │
       ▼
创建 Annotation 子节点
  - annotationRef: 批注 UUID
  - text / annotationSummary: 批注原文前 50 字 + note 摘要
  - annotationFilePath: 批注源文件路径
       │
       ▼
渲染为特殊子节点
  - 虚线边框（区别于普通实线边框）
  - 左上角批注图标
  - 摘要文本 (MD 渲染)
  - tags 色点 + flags 徽章 (如 mastery ★★)
  - motivation 语义着色 (边框颜色)
       │
       ├── hover → 展开浮窗 (note + tags + flags + relations)
       ├── click → 跳转原文
       ├── 双击 → 编辑摘要
       └── 拖拽 → 移动到其他父节点下
```

### 6.3 批注节点与原批注的关系

| 操作 | 批注节点 | 原 MarkVault 批注 |
|------|---------|------------------|
| 添加批注到导图 | 创建 Annotation 子节点 | 不变 |
| 删除批注节点 | 移除节点 + 清理 frontmatter 引用 | 不变 |
| 编辑批注节点摘要 | 只改导图中的摘要 | 不变 |
| 原 MarkVault 批注变更 | 实时刷新摘要+tags/flags+语义着色 | 原始数据 |
| 原 MarkVault 批注删除 | 标记为"已失效"（红色删除线+灰色背景） | 已删除 |

### 6.4 反向联动

- MarkVault 批注变更 → `onAnnotationChange` → 刷新对应 Annotation 子节点
- MarkVault 批注删除 → Annotation 子节点标记为"已失效"
- 批注节点点击 → `workspace.openLinkText` 打开源文件并滚动到批注位置

### 6.5 MarkVault API 依赖

```typescript
interface MarkVaultAPI {
  // ── 基础查询 ──
  getAnnotation(uuid: string): Annotation | null;
  searchAnnotations(query: string): Annotation[];
  getFileAnnotations(filePath: string): Annotation[];

  // ── 事件监听 ──
  onAnnotationChange(handler: (event: AnnotationChangeEvent) => void): void;

  // ── v3.0: 标注创建（方案B） ──
  addAnnotation(annotation: Partial<Annotation>): Annotation;
  removeAnnotation(uuid: string): void;

  // ── v3.0: docType 路由 ──
  getAnnotationsByDocType(docType: string): Annotation[];
  getAnnotationsBySelector(selector: MindmapSelector): Annotation[];
}
```

如果 MarkVault 未安装或未启用，MindFlow 正常运行（无 Annotation 功能，仅 MD-Seed + Free）。

---

## 7. 视觉增强

### 7.1 节点类型视觉区分

| 节点类型 | 边框 | 角标 | 背景 | 标注覆盖 |
|---------|------|------|------|---------|
| MD-Seed | 实线，灰色 | 无 | 白色 | 有标注时：背景色=annotation.color |
| Free | 实线，主题色 | 右上角小 "F" | 浅色 | 有标注时：背景色=annotation.color |
| Annotation | **虚线**，语义色 | 左上角批注图标 | 浅语义色 | 始终有 |

### 7.2 语义着色

复用 MarkVault 的 SEMANTIC_GROUPS 调色板：

| motivation | 维度 | 节点边框色 | 节点背景色(15%透明) |
|------------|------|-----------|-------------------|
| classifying / identifying | Taxonomic | #534AB7 | rgba(83,74,183,0.15) |
| questioning / assessing | Argumentative | #3B6D11 | rgba(59,109,17,0.15) |
| explaining / linking | Expository | #BA7517 | rgba(186,117,23,0.15) |
| referencing | Referential | #0F6E56 | rgba(15,110,86,0.15) |
| comparing | Comparative | #185FA5 | rgba(24,95,165,0.15) |
| hypothesizing / predicting | Dynamic | #534AB7 | rgba(83,74,183,0.15) |

### 7.3 学习状态可视化

| flags 字段 | 视觉效果 |
|-----------|---------|
| mastery (1~3) | 边框粗细 1px → 3px，颜色加深 |
| needsCorrection | 红色虚线内边框 |
| reviewPriority (high) | 橙色角标 |
| confidence (low) | 节点半透明 (opacity: 0.7) |

### 7.4 智能连线样式

| 关系类型 | 连线样式 |
|---------|---------|
| 父子（树结构） | 实线，灰色 |
| Annotation 子节点连接 | 虚线，语义色 |
| 选框标注连线 | 点线，annotation.color 色 |
| 双向关系 | 弧线 (curvature > 0) |
| 同向多关系 | 曲率分离 (复用 computeCurvature) |

### 7.5 多种布局主题

| 布局 | 描述 | 实现 |
|------|------|------|
| 右侧树 | 根节点左侧，子节点向右展开 | 默认 |
| 中心放射 | 根节点居中，子节点四周展开 | 角度分配算法 |
| 组织结构 | 根节点顶部，子节点向下展开 | 逐层水平排列 |
| 鱼骨图 | 分类节点左右交替排列 | 奇偶层方向反转 |

布局切换：CSS transition，300ms ease-out。

### 7.6 聚焦模式

- 选中节点 → 同级和子级正常显示
- 其他子树 → `opacity: 0.15`
- 点击空白处 → 取消聚焦
- 折叠/展开 → `max-height` + `opacity` CSS transition

---

## 8. 命令与交互

### 8.1 命令列表

| 命令 | 快捷键 | 描述 |
|------|--------|------|
| `mindflow:create` | Ctrl+Shift+M | 创建新的思维导图文件并打开 |
| `mindflow:open` | — | 打开当前文件的思维导图视图 |
| `mindflow:annotate-node` | — | 对选中节点创建标注（方案B） |
| `mindflow:group-annotate` | — | 框选多个节点创建选框标注 |
| `mindflow:add-annotation` | — | 将选中的 MarkVault 批注添加为子节点 |
| `mindflow:toggle-layout` | — | 切换布局主题 |
| `mindflow:focus-mode` | — | 切换聚焦模式 |
| `mindflow:collapse-all` | — | 折叠所有分支 |
| `mindflow:expand-all` | — | 展开所有分支 |
| `mindflow:export-svg` | — | 导出为 SVG |
| `mindflow:export-png` | — | 导出为 PNG |

### 8.2 节点交互

| 操作 | 效果 |
|------|------|
| 单击节点 | 选中，显示工具栏 |
| 双击节点 | 进入编辑模式 (contentEditable) |
| 右键节点 | 上下文菜单 |
| Tab | 在选中节点下添加 Free 子节点 |
| Enter | 在同级添加 Free 兄弟节点 |
| Delete | 删除节点 |
| Ctrl+Z | 撤销 |
| 拖拽节点 | 调整顺序/层级 |
| 从 MarkVault 侧栏拖入 | 创建 Annotation 子节点 |

### 8.3 标注交互

| 操作 | 效果 |
|------|------|
| 右键节点 → "标注此节点" | 创建 mindmap docType 标注 + 插入 MD 锚点 |
| 框选多节点 → "选框标注" | 创建 region 选框标注 |
| hover 标注节点 | 浮窗：note + tags + flags + relations |
| click 标注图标 | 打开源文件定位 |
| click 选框区域 | 显示选框标注详情 |

---

## 9. 文件结构

```
src/
  mindflow/                         # MindFlow 子模块
    types/
      mind-node.ts                  # MindNode + AnnotationOverlay 数据类型
      mindmap-selector.ts           # mindmapSelector 类型定义
      layout-theme.ts               # 布局主题枚举
    data/
      md-parser.ts                  # Markdown → MindNode 树解析（MD-Seed）
      frontmatter-sync.ts           # frontmatter 读写（Free/Annotation 节点）
      seed-sync.ts                  # MD-Seed 单向映射同步
      markvault-bridge.ts           # MarkVault API 桥接
      annotation-overlay-sync.ts    # v3.0: 标注覆盖信息计算（背景色+边框色）
      group-annotation-sync.ts      # v3.0: 选框标注同步+包围矩形计算
    layout/
      tree-layout.ts                # 树形布局算法
      radial-layout.ts              # 中心放射布局
      org-layout.ts                 # 组织结构布局
      fishbone-layout.ts            # 鱼骨图布局
    render/
      node-renderer.ts              # 节点 DOM 渲染（统一入口）
      md-inline-renderer.ts         # MD 行内语法渲染器
      svg-connector.ts              # SVG 连线渲染
      node-type-styler.ts           # 三种节点类型视觉区分
      annotation-renderer.ts        # 批注子节点专属渲染
      annotation-overlay.ts         # v3.0: 标注覆盖渲染（背景色+边框色）
      group-box-renderer.ts         # v3.0: 选框标注 SVG 矩形渲染
    view/
      mindflow-view.ts              # 主视图 (ItemView)
      node-editor.ts               # contentEditable 编辑器
      context-menu.ts               # 右键菜单
      toolbar.ts                    # 工具栏
      annotation-picker.ts          # v3.0: 标注创建/颜色选择面板
      group-select.ts               # v3.0: 多节点框选交互
    theme/
      semantic-palette.ts           # 语义调色板（复用 MarkVault）
      layout-transitions.ts         # 布局切换动画
    export/
      svg-export.ts                 # SVG 导出
      png-export.ts                 # PNG 导出 (html2canvas)
```

---

## 10. MarkVault 扩展需求

MindFlow 的标注功能需要 MarkVault 提供以下扩展（与 PDF 扩展共享基础设施）：

### 10.1 docType 路由机制

```typescript
// 在 annotation-store.ts 中
private docTypeRegistry: Map<string, DocTypeHandler> = new Map();

registerDocType(handler: DocTypeHandler): void {
  this.docTypeRegistry.set(handler.docType, handler);
}

getAnnotationsByDocType(docType: string): Annotation[] {
  return this.getByIndex('docType', docType);
}
```

### 10.2 新增索引

| 索引 | 键 | 用途 |
|------|---|------|
| `byDocType` | `docType: string` | 按文档类型查询标注 |
| `byNodeId` | `mindmapSelector.nodeId` | 按导图节点 ID 查询标注 |

### 10.3 Annotation 接口扩展

```typescript
interface Annotation {
  // ── 现有字段保持不变 ──
  // ...

  // ── 新增: 文档类型标识 ──
  docType?: 'markdown' | 'pdf' | 'mindmap';  // 默认 'markdown'

  // ── 新增: PDF 专有定位 (PDF 扩展已规划) ──
  pdfSelector?: PDFSelector;

  // ── 新增: Mindmap 专有定位 ──
  mindmapSelector?: MindmapSelector;
}
```

### 10.4 Format 层扩展

```typescript
// Mindmap 标注的锚点格式复用 MarkVault 现有的 NativeFormat
// %%mv:i:uuid:bold:yellow%%**文本**
// 不需要新的 Format 类，NativeFormat 已支持

// 选框标注不嵌入 MD 正文，走 AnnotationStore 独立存储
class MindmapFormat implements AnnotationFormat {
  readonly id = 'mindmap';

  parse(): ParsedAnnotation[] { return []; }  // 选框标注不解析
  build(): string { return ''; }              // 不写入 MD
  update(): string | null { return null; }
  remove(): string | null { return null; }
  strip(): string { return ''; }
}
```

---

## 11. 依赖

| 依赖 | 用途 | 版本 |
|------|------|------|
| Obsidian API | 插件 SDK | ^1.7.2 |
| KaTeX | LaTeX 渲染 | ^0.16.x |
| MarkVault-JS | 标注系统（可选依赖） | ^5.0.0 |

不引入 Canvas/WebGL 框架、不引入 ProseMirror、不引入虚拟 DOM 库。

---

## 12. 分期交付

### Phase 1: MVP（2 周）

- [ ] MD Parser：标题 + 列表 → MindNode 树（MD-Seed 节点）
- [ ] 右侧树布局 + SVG 贝塞尔连线
- [ ] 节点展示（纯文本，无 MD 渲染）
- [ ] Pan / Zoom
- [ ] 折叠 / 展开
- [ ] `mindflow:create` + `mindflow:open` 命令
- [ ] Frontmatter 读写（存储 Free 节点）
- [ ] MD-Seed 单向映射（MD→导图自动更新）

### Phase 2: MD 渲染 + 编辑（1 周）

- [ ] MD Inline Renderer（bold/italic/code/link/highlight）
- [ ] contentEditable 编辑态切换
- [ ] LaTeX 渲染 (KaTeX)
- [ ] 标注锚点隐身处理（`%%mv:i%%` 不显示，粗体正常渲染）
- [ ] Tab / Enter / Delete 键盘交互
- [ ] 拖拽排序
- [ ] 三种节点类型视觉区分

### Phase 3: 标注系统接入（1.5 周）

- [ ] MarkVault Bridge API
- [ ] 批注作为子节点（拖入/添加 Annotation 子节点）
- [ ] Annotation 节点渲染（虚线边框 + 摘要 + 批注图标）
- [ ] **方案B: 节点文本标注** — 创建 docType='mindmap' 标注 + 锚点
- [ ] **标注覆盖渲染** — annotation.color → 节点背景色，motivation → 边框色
- [ ] docType 路由机制 + mindmapSelector 注册
- [ ] hover 浮窗预览（note + tags + flags）
- [ ] click 跳转原文
- [ ] 批注变更实时同步刷新

### Phase 4: 选框 + 视觉增强（1 周）

- [ ] **选框标注** — 框选多节点 → 创建 region 标注 → SVG 虚线矩形
- [ ] 选框包围矩形计算 + 节点移动自动跟随
- [ ] 语义着色（motivation → 边框色）
- [ ] 学习状态可视化（mastery/needsCorrection/reviewPriority）
- [ ] 智能连线样式
- [ ] 多布局主题切换
- [ ] 聚焦模式
- [ ] SVG/PNG 导出

### Phase 5: 未来扩展

- [ ] 移动端适配
- [ ] 导图节点内字符级高亮（方案A，可选）
- [ ] AI 辅助扩展（自动建议子节点）
- [ ] 大规模虚拟化（500+ 节点）
- [ ] W3C 导出（mindmapSelector → W3C FragmentSelector + SvgSelector）
- [ ] 跨文件 MD 导入为分支

**总工期：5.5 周（1 人全职）**

---

## 13. 风险与缓解

| 风险 | 影响 | 概率 | 缓解 |
|------|------|------|------|
| 大量节点 DOM 性能 | 500+ 节点卡顿 | 中 | Virtual Scroll + rAF 批量更新 |
| MD-Seed 映射与自由节点混合 | 结构混乱 | 低 | 三种类型严格区分 + 视觉区分清晰 |
| Markdown 列表解析 | 嵌套/多行解析复杂 | 中 | Phase 1 仅单行列表项，多行 Phase 2+ |
| contentEditable 兼容性 | 移动端/浏览器差异 | 低 | Phase 1 仅桌面端 |
| frontmatter 体积膨胀 | 大量节点时过大 | 低 | Phase 1 不处理，后续拆分存储 |
| MarkVault API 不稳定 | 标注联动失效 | 中 | 优雅降级：不可用时仅 MD-Seed + Free |
| docType 路由与 PDF 扩展耦合 | PDF 扩展延期影响 MindFlow | 低 | docType 路由独立实现，不依赖 PDF 扩展完成 |
| 选框节点移动后包围矩形 | 计算性能 | 低 | 缓存包围矩形 + onLayoutChange 才重算 |
| 标注锚点与 MD 渲染冲突 | `%%mv:i%%` 可能被 inline renderer 误渲染 | 低 | inline renderer 第一步 strip 锚点，第二步渲染粗体 |

---

## 14. 与 PDF 扩展的协作关系

| 基础设施 | 谁先建 | 谁复用 | 分摊比例 |
|---------|-------|-------|---------|
| `docType` 字段路由 | PDF 扩展 | MindFlow | PDF 80% / MindFlow 20% |
| Selector 注册机制 | PDF 扩展 | MindFlow | PDF 70% / MindFlow 30% |
| 按类型查询索引 | PDF 扩展 | MindFlow | PDF 60% / MindFlow 40% |
| Annotation 接口扩展 | 共建 | 双方 | 50% / 50% |
| W3C 兼容层 | PDF 扩展 | MindFlow | PDF 90% / MindFlow 10% |
| 认知数据层 | 已有 | 双方 | 0% (已有) |

**关键结论**：PDF 扩展建好 docType + Selector 路由后，MindFlow 的选框标注只需 20% 额外工作量即可接入完整标注系统。
