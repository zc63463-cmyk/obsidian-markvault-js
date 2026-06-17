# MindFlow — Obsidian 思维导图插件设计文档

> 版本: v2.0 | 日期: 2026-06-17 | 状态: DRAFT
>
> v2.0 变更：从"MD文件映射"模式改为"独立导图 + 批注子节点"模式

## 1. 概述

**MindFlow** 是一个 Obsidian 思维导图插件，**独立创建思维导图**，以 .md 文件的标题/列表作为初始骨架，用户自由扩展，批注作为子节点接入。

### 1.1 核心定位

- **独立创建**思维导图（不是把当前文件直接映射成导图）
- .md 文件标题/列表作为初始骨架（单向映射，只读种子），用户在导图中自由扩展
- MarkVault 批注作为**子节点**接入导图（不是附着的 Badge）
- 纯 Markdown 源 + frontmatter 混合存储

### 1.2 三大差异化卖点

1. **节点内 MD 实时渲染** — `**粗体**` / `` `代码` `` / `$LaTeX$` / `[[链接]]` 在节点内即时渲染
2. **批注作为子节点** — MarkVault 批注可拖入导图作为分支/子节点，显示摘要、跳转原文、语义着色
3. **语义视觉增强** — 复用 MarkVault 的 SEMANTIC_GROUPS 调色板，按 motivation/flags 着色

### 1.3 技术方案：DOM-Flow

选择 DOM 节点 + SVG 连线 + CSS 弹性布局，而非 Canvas 或 WebGL：
- 节点就是 DOM 元素，contentEditable 编辑零摩擦
- SVG 连线支持样式化（虚线、颜色、箭头）
- CSS transition 动画（折叠/展开/布局切换）
- 性能目标：500 节点内流畅（超出时虚拟化滚动）

---

## 2. 数据模型

### 2.1 三种节点类型

| 类型 | 来源 | MD 同步 | 存储 | 视觉区分 |
|------|------|---------|------|---------|
| **MD-Seed** | .md 文件标题/列表 | 单向映射（只读种子） | .md 正文 | 实线边框，普通样式 |
| **Free** | 用户在导图中手动创建 | 不同步回 MD | frontmatter JSON | 实线边框，带 "F" 角标 |
| **Annotation** | 从 MarkVault 拖入/添加 | 引用批注 UUID | frontmatter JSON | **虚线边框**，带批注图标 |

### 2.2 MindNode 数据结构

```typescript
interface MindNode {
  id: string;              // UUID
  filePath: string;        // 所属 .md 文件路径
  type: 'root' | 'branch' | 'leaf' | 'free' | 'annotation';

  // ─── 文本内容 ─────────────────────────
  text: string;            // MD 原始文本（未渲染）
  richText?: string;       // 渲染后 HTML（缓存）

  // ─── MD-Seed 定位（仅 type !== 'free' && type !== 'annotation'） ──
  mdSource?: {              // MD 正文中的来源位置
    startLine: number;      // 起始行号
    endLine?: number;       // 结束行号（多行节点）
    startOffset: number;    // 行内偏移
    endOffset: number;
  };

  // ─── 自由节点 ─────────────────────────
  isFree?: boolean;         // true = 不映射回 MD

  // ─── 批注引用 ─────────────────────────
  annotationRef?: string;   // MarkVault 批注 UUID
  annotationSummary?: string;// 批注摘要缓存（原文前 50 字 + note）
  annotationFilePath?: string;// 批注源文件路径（用于跳转）

  // ─── 树结构 ─────────────────────────
  parentId: string | null;
  childrenIds: string[];
  level: number;           // 层级深度

  // ─── 视觉状态（运行时） ──────────────
  collapsed?: boolean;
  layoutX?: number;
  layoutY?: number;
}
```

### 2.3 .md 文件存储格式

思维导图本身是一个 `.md` 文件，结构如下：

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
    - id: n6
      parentId: n2
      annotationRef: "uuid-def-456"
      annotationSummary: "注意区分逆矩阵和伴随矩阵"
      annotationFilePath: "Notes/数学/线性代数.md"
---

# 学习计划

## 核心概念

- 向量空间
- 线性映射
- 特征值

## 应用场景

- 数据压缩
- 图像处理
```

**存储规则：**
- `.md` 正文（标题+列表）→ **MD-Seed 节点**，只读种子
- frontmatter `mindmap.nodes` → **Free 节点 + Annotation 节点**，以及不在正文中的元数据
- 导图编辑 MD-Seed 节点 → 同步修改 .md 正文
- 导图编辑 Free/Annotation 节点 → 同步修改 frontmatter
- **.md 正文编辑 → 重新解析标题/列表 → 更新 MD-Seed 节点**（单向：MD 变更反映到导图）

### 2.4 MD-Seed 单向映射

**MD → 导图（读取路径）：**
1. 监听 `vault.on('modify')` 事件
2. 解析 .md 文件的标题层级 + 列表层级
3. 与当前导图中的 MD-Seed 节点 Diff
4. 增量更新：新增标题→新增节点，删除标题→删除节点，修改标题→更新文本
5. Free/Annotation 节点不受影响

**导图 → MD（写入路径）：**
- 编辑 MD-Seed 节点 → 同步修改 .md 对应行
- 编辑 Free/Annotation 节点 → 只改 frontmatter
- 拖拽 MD-Seed 节点调整层级 → 修改 .md 中标题级别（`#` → `##` 等）

---

## 3. 视图架构（四层分离）

### 3.1 L1 Data Sync

| 组件 | 职责 |
|------|------|
| MD Parser | 解析标题/列表层级为 MindNode 树（MD-Seed 节点） |
| Frontmatter Sync | 读写 frontmatter 中的 Free/Annotation 节点 |
| Seed Sync | MD-Seed 单向映射（MD→导图自动更新，导图→MD 手动编辑同步） |
| MarkVault Bridge | 读取 AnnotationStore，获取批注数据用于 Annotation 子节点 |
| Undo/Redo Stack | 基于 Obsidian Editor 的原生 undo/redo |

### 3.2 L2 Layout Engine

| 组件 | 职责 |
|------|------|
| Tree Layout | 计算节点 x/y 位置（右侧树/中心放射/组织结构） |
| SVG Connector | 绘制节点间连线（贝塞尔曲线/折线） |
| Pan / Zoom | CSS transform 实现画布平移缩放 |
| Virtual Scroll | 500+ 节点时只渲染可视区域 DOM |

### 3.3 L3 Node Renderer

| 组件 | 职责 |
|------|------|
| MD Inline Renderer | `**b**` / `` `c` `` / `$L$` / `[[w]]` → 渲染富文本 |
| Node Type Styler | 三种节点类型的视觉区分（实线/虚线/角标） |
| Annotation Renderer | 批注摘要渲染 + tags/flags 徽章 |
| ContentEditable | focus → 源码模式，blur → 渲染模式 |

### 3.4 L4 Theme Layer

| 组件 | 职责 |
|------|------|
| CSS Variables | 节点/连线/背景颜色变量 |
| Semantic Palette | 复用 MarkVault 的 6 维度 SEMANTIC_GROUPS |
| Animation | CSS transition (折叠/展开/布局切换) |
| Dark/Light | 跟随 Obsidian 主题切换 |

---

## 4. 节点内 Markdown 实时渲染

### 4.1 支持的行内语法

| 语法 | 渲染效果 | 实现方式 |
|------|---------|---------|
| `**bold**` | **粗体** | `<strong>` |
| `*italic*` | *斜体* | `<em>` |
| `` `code` `` | `代码` | `<code>` |
| `$LaTeX$` | KaTeX 渲染 | katex.renderToString() |
| `[[wiki link]]` | 可点击链接 | `<a>` + Obsidian openLinkText |
| `[text](url)` | 超链接 | `<a>` |
| `==highlight==` | 高亮 | `<mark>` |
| `~~strikethrough~~` | 删除线 | `<del>` |

### 4.2 编辑态切换

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

### 4.3 自研轻量 MD Inline Renderer

不引入 ProseMirror/CodeMirror（太重），自研基于正则的 inline parser：
- 分词：将文本拆分为 text / bold / italic / code / latex / link 片段
- 渲染：每个片段映射到对应 HTML 标签
- LaTeX：异步渲染，先占位后替换
- 安全：XSS 过滤，禁止 `<script>` / `<iframe>`

---

## 5. 批注-导图联动 (MarkVault Bridge)

### 5.1 批注作为子节点

批注不是附着的 Badge，而是**完整的子节点**，挂载到导图任意节点下。

```
用户操作：
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
  - 左上角批注图标 (铅笔/便签)
  - 摘要文本 (MD 渲染)
  - tags 色点 + flags 徽章 (如 mastery ★★)
  - motivation 语义着色 (边框颜色)
       │
       ├── hover → 展开浮窗
       │   (批注完整 note + tags + flags + relations)
       │
       ├── click → 跳转原文
       │   (打开源文件，定位到批注所在行)
       │
       ├── 双击 → 编辑摘要
       │   (只改导图中的摘要，不修改原批注)
       │
       └── 拖拽 → 移动到其他父节点下
           (不改变原批注，只改变导图结构)
```

### 5.2 批注节点与原批注的关系

| 操作 | 批注节点 | 原 MarkVault 批注 |
|------|---------|------------------|
| 添加批注到导图 | 创建 Annotation 子节点 | 不变 |
| 删除批注节点 | 移除节点 + 清理 frontmatter 引用 | 不变 |
| 编辑批注节点摘要 | 只改导图中的摘要 | 不变 |
| 原 MarkVault 批注变更 | 实时刷新摘要 + tags/flags + 语义着色 | 原始数据 |
| 原 MarkVault 批注删除 | 标记为"已失效"（红色删除线） | 已删除 |

### 5.3 反向联动

- MarkVault 批注变更 → `onAnnotationChange` → 刷新对应 Annotation 子节点的摘要/徽章/语义着色
- MarkVault 批注删除 → Annotation 子节点标记为"已失效"（红色删除线 + 灰色背景），用户可手动移除
- 批注节点点击 → `workspace.openLinkText` 打开源文件并滚动到批注位置

### 5.4 MarkVault API 依赖

```typescript
interface MarkVaultAPI {
  getAnnotation(uuid: string): Annotation | null;
  searchAnnotations(query: string): Annotation[];
  onAnnotationChange(handler: (event: AnnotationChangeEvent) => void): void;
  getFileAnnotations(filePath: string): Annotation[];
}
```

如果 MarkVault 未安装或未启用，MindFlow 正常运行（无 Annotation 节点功能，仅 MD-Seed + Free）。

---

## 6. 视觉增强

### 6.1 节点类型视觉区分

| 节点类型 | 边框 | 角标 | 背景 |
|---------|------|------|------|
| MD-Seed | 实线，灰色 | 无 | 白色 |
| Free | 实线，主题色 | 右上角小 "F" | 浅色 |
| Annotation | **虚线**，语义色 | 左上角批注图标 | 浅语义色 |

### 6.2 语义着色

复用 MarkVault 的 SEMANTIC_GROUPS 调色板，按批注的 `motivation` 字段自动着色 Annotation 节点边框：

| motivation | 维度 | 节点边框色 |
|------------|------|-----------|
| classifying / identifying | Taxonomic | indigo (#534AB7) |
| questioning / assessing | Argumentative | green (#3B6D11) |
| explaining / linking | Expository | amber (#BA7517) |
| referencing | Referential | cyan (#0F6E56) |
| comparing | Comparative | blue (#185FA5) |
| hypothesizing / predicting | Dynamic | teal (#0F6E56) |

MD-Seed / Free 节点 = 默认灰色边框。

### 6.3 学习状态可视化（Annotation 节点）

| flags 字段 | 视觉效果 |
|-----------|---------|
| mastery (1~3) | 边框粗细 1px → 3px，颜色加深 |
| needsCorrection | 红色虚线内边框 |
| reviewPriority (high) | 橙色角标 |
| confidence (low) | 节点半透明 (opacity: 0.7) |

### 6.4 智能连线样式

| 关系类型 | 连线样式 |
|---------|---------|
| 父子（树结构） | 实线，灰色 |
| Annotation 子节点连接 | 虚线，语义色 |
| 双向关系 | 弧线 (curvature > 0) |
| 同向多关系 | 曲率分离 (复用 computeCurvature) |

### 6.5 多种布局主题

| 布局 | 描述 | 实现 |
|------|------|------|
| 右侧树 | 根节点左侧，子节点向右展开 | 默认 |
| 中心放射 | 根节点居中，子节点四周展开 | 角度分配算法 |
| 组织结构 | 根节点顶部，子节点向下展开 | 逐层水平排列 |
| 鱼骨图 | 分类节点左右交替排列 | 奇偶层方向反转 |

布局切换：CSS transition，所有节点同时 transform 到新位置，300ms ease-out。

### 6.6 聚焦模式

- 选中节点 → 同级和子级正常显示
- 其他子树 → `opacity: 0.15`
- 点击空白处 → 取消聚焦
- 折叠/展开 → `max-height` + `opacity` CSS transition

---

## 7. 命令与交互

### 7.1 命令列表

| 命令 | 快捷键 | 描述 |
|------|--------|------|
| `mindflow:create` | Ctrl+Shift+M | 创建新的思维导图文件并打开 |
| `mindflow:open` | — | 打开当前文件的思维导图视图 |
| `mindflow:add-annotation` | — | 将选中的 MarkVault 批注添加为子节点 |
| `mindflow:toggle-layout` | — | 切换布局主题 |
| `mindflow:focus-mode` | — | 切换聚焦模式 |
| `mindflow:collapse-all` | — | 折叠所有分支 |
| `mindflow:expand-all` | — | 展开所有分支 |
| `mindflow:export-svg` | — | 导出为 SVG |
| `mindflow:export-png` | — | 导出为 PNG |

### 7.2 节点交互

| 操作 | 效果 |
|------|------|
| 单击节点 | 选中，显示工具栏 |
| 双击节点 | 进入编辑模式 (contentEditable) |
| 右键节点 | 上下文菜单（编辑/删除/添加子节点/添加批注/跳转原文） |
| Tab | 在选中节点下添加 Free 子节点 |
| Enter | 在同级添加 Free 兄弟节点 |
| Delete | 删除节点（MD-Seed 同时删 MD 行，Free/Annotation 只删 frontmatter 引用） |
| Ctrl+Z | 撤销 |
| 拖拽节点 | 调整顺序/层级 |
| 从 MarkVault 侧栏拖入 | 创建 Annotation 子节点 |

### 7.3 批注节点特有交互

| 操作 | 效果 |
|------|------|
| hover 批注图标 | 浮窗：note 全文 + tags + flags + relations |
| click 批注图标 | 打开源文件，定位到批注行 |
| 双击批注节点 | 编辑导图中的摘要（不改原批注） |
| 右键"跳转原文" | 同 click 批注图标 |
| 右键"刷新批注" | 强制从 MarkVault 重新获取数据 |

---

## 8. 文件结构

```
src/
  mindflow/                    # MindFlow 子模块
    types/
      mind-node.ts             # MindNode 数据类型
      layout-theme.ts          # 布局主题枚举
    data/
      md-parser.ts             # Markdown → MindNode 树解析（MD-Seed）
      frontmatter-sync.ts      # frontmatter 读写（Free/Annotation 节点）
      seed-sync.ts             # MD-Seed 单向映射同步
      markvault-bridge.ts      # MarkVault API 桥接
    layout/
      tree-layout.ts           # 树形布局算法
      radial-layout.ts         # 中心放射布局
      org-layout.ts            # 组织结构布局
      fishbone-layout.ts       # 鱼骨图布局
    render/
      node-renderer.ts         # 节点 DOM 渲染（统一入口）
      md-inline-renderer.ts    # MD 行内语法渲染器
      svg-connector.ts         # SVG 连线渲染
      node-type-styler.ts      # 三种节点类型视觉区分
      annotation-renderer.ts   # 批注子节点专属渲染
    view/
      mindflow-view.ts         # 主视图 (ItemView)
      node-editor.ts           # contentEditable 编辑器
      context-menu.ts          # 右键菜单
      toolbar.ts               # 工具栏
    theme/
      semantic-palette.ts      # 语义调色板（复用 MarkVault）
      layout-transitions.ts    # 布局切换动画
    export/
      svg-export.ts            # SVG 导出
      png-export.ts            # PNG 导出 (html2canvas)
```

---

## 9. 依赖

| 依赖 | 用途 | 版本 |
|------|------|------|
| Obsidian API | 插件 SDK | ^1.7.2 |
| KaTeX | LaTeX 渲染 | ^0.16.x |
| MarkVault-JS | 批注联动（可选） | ^5.0.0 |

不引入 Canvas/WebGL 框架、不引入 ProseMirror、不引入虚拟 DOM 库。

---

## 10. 分期交付

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
- [ ] Tab / Enter / Delete 键盘交互
- [ ] 拖拽排序
- [ ] 三种节点类型视觉区分

### Phase 3: 批注联动（1 周）

- [ ] MarkVault Bridge API
- [ ] 从 MarkVault 侧栏拖入批注 → 创建 Annotation 子节点
- [ ] Annotation 节点渲染（虚线边框 + 摘要 + 批注图标）
- [ ] hover 浮窗预览（note + tags + flags）
- [ ] click 跳转原文
- [ ] 批注变更实时同步刷新
- [ ] 批注删除 → 标记"已失效"

### Phase 4: 视觉增强（1 周）

- [ ] 语义着色（motivation → Annotation 节点边框色）
- [ ] 学习状态可视化（mastery/needsCorrection/reviewPriority）
- [ ] 智能连线样式
- [ ] 多布局主题切换
- [ ] 聚焦模式
- [ ] SVG/PNG 导出

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 大量节点 DOM 性能 | 500+ 节点卡顿 | Virtual Scroll + requestAnimationFrame 批量更新 |
| MD-Seed 映射与自由节点混合 | 结构混乱 | 严格区分三种类型，视觉区分清晰 |
| Markdown 列表解析 | 嵌套列表/多行列表项解析复杂 | Phase 1 仅支持单行列表项，多行 Phase 2+ |
| MarkVault API 不稳定 | 批注联动失效 | 优雅降级：MarkVault 不可用时无 Annotation 功能，核心功能正常 |
| contentEditable 兼容性 | 移动端/不同浏览器行为差异 | Phase 1 仅桌面端，移动端 Phase 4+ |
| frontmatter 体积膨胀 | 大量 Free/Annotation 节点时 frontmatter 过大 | Phase 1 不处理，后续考虑拆分存储 |
