# MindFlow — Obsidian 思维导图插件设计文档

> 版本: v1.0 | 日期: 2026-06-17 | 状态: DRAFT

## 1. 概述

**MindFlow** 是一个 Obsidian 思维导图插件，采用 **混合模式**：核心结构双向映射 Markdown 标题/列表，同时支持自由节点和纯导图区域。

### 1.1 核心定位

- Markdown 笔记的可视化延伸（不是独立工具）
- 纯 Markdown 源存储（零额外 JSON/数据库）
- 与 MarkVault-JS 批注系统深度联动

### 1.2 三大差异化卖点

1. **节点内 MD 实时渲染** — `**粗体**` / `` `代码` `` / `$LaTeX$` / `[[链接]]` 在节点内即时渲染
2. **批注-导图联动** — 有批注的节点自动显示 Badge，hover 预览，点击跳转
3. **语义视觉增强** — 复用 MarkVault 的 SEMANTIC_GROUPS 调色板，按 motivation/flags 着色

### 1.3 技术方案：B. DOM-Flow

选择 DOM 节点 + SVG 连线 + CSS 弹性布局，而非 Canvas 或 WebGL：
- 节点就是 DOM 元素，contentEditable 编辑零摩擦
- SVG 连线支持样式化（虚线、颜色、箭头）
- CSS transition 动画（折叠/展开/布局切换）
- 性能目标：500 节点内流畅（超出时虚拟化滚动）

---

## 2. 数据模型与 Markdown 映射

### 2.1 映射规则

| Markdown 元素 | MindFlow 节点类型 | 层级 |
|--------------|------------------|------|
| `# heading` | Root 节点 | 0 |
| `## heading` | Branch 节点 | 1 |
| `### ~ ######` | Branch 节点 | 2~5 |
| `- / * list item` | Leaf 节点 | 父级+1 |
| `> [!callout]` | Typed 节点（带类型标签） | 父级+1 |
| `---` (thematic break) | 分区线 | - |
| `%%markvault%%` | 批注锚点（不可见） | - |

### 2.2 MindNode 数据结构

```typescript
interface MindNode {
  id: string;              // UUID，由 MD 行号+文件路径哈希生成
  filePath: string;        // 所属 Markdown 文件路径
  type: 'root' | 'branch' | 'leaf' | 'free';
  level: number;           // 层级深度
  text: string;            // MD 原始文本（未渲染）
  richText?: string;       // 渲染后 HTML（缓存）
  startLine: number;       // MD 源行号（双向同步锚点）
  endLine?: number;        // 多行节点结束行
  startOffset: number;     // 行内偏移
  endOffset: number;

  // 树结构
  parentId: string | null;
  childrenIds: string[];

  // 自由节点（不属于 MD 结构）
  // 自由节点在纯 MD 源模式下不持久化——Phase 1 不实现自由节点
  // Phase 2+: 自由节点存入 frontmatter mindflow.freeNodes JSON
  isFree?: boolean;        // true = 不映射回 MD

  // 批注关联（运行时计算，不持久化）
  annotationIds?: string[];// 关联的 MarkVault 批注 UUID

  // 视觉状态（运行时）
  collapsed?: boolean;
  layoutX?: number;
  layoutY?: number;
}
```

### 2.3 双向同步机制

**MD → 树（读取路径）：**
1. 监听 `vault.on('modify')` 事件
2. 使用 Obsidian MetadataCache 获取缓存区标题列表
3. 重新解析列表层级（MetadataCache 不含列表，需自研 parser）
4. Diff 旧/新树，最小化 DOM 更新

**树 → MD（写入路径）：**
1. 用户编辑节点 contentEditable → 失焦/Ctrl+Enter
2. 计算 targetLine + startOffset + endOffset
3. 通过 `vault.modify(file, newContent)` 精确替换对应行
4. 触发 `vault.on('modify')` → 重新解析（去重：500ms debounce）

**冲突处理：**
- 编辑器修改和导图修改同时发生 → 最后写入胜出 (LWW)
- 使用 `vault.on('modify')` debounce 合并快速连续变更

---

## 3. 视图架构（四层分离）

### 3.1 L1 Data Sync

| 组件 | 职责 |
|------|------|
| MD Parser | 解析标题/列表层级为 MindNode 树 |
| Tree ↔ MD Sync | 双向同步，行号+偏移精确定位 |
| MarkVault Bridge | 读取 AnnotationStore，关联批注到节点 |
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
| Annotation Badge | 色点(tags) + 星标(flags) + 笔记图标(note) |
| ContentEditable | focus → 源码模式，blur → 渲染模式 |
| Relation Line | 跨节点关系连线（复用 MarkVault 关系类型色） |

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
       │        同步回MD源文件          │
```

### 4.3 自研轻量 MD Inline Renderer

不引入 ProseMirror/CodeMirror（太重），自研基于正则的 inline parser：
- 分词：将文本拆分为 text / bold / italic / code / latex / link 片段
- 渲染：每个片段映射到对应 HTML 标签
- LaTeX：异步渲染，先占位后替换
- 安全：XSS 过滤，禁止 `<script>` / `<iframe>`

---

## 5. 批注-导图联动 (MarkVault Bridge)

### 5.1 联动链路

```
MD 文件中的 %%markvault%% 锚点
       │
       ▼
按 startLine/startOffset 匹配 Annotation UUID
       │
       ▼
节点渲染 Annotation Badge
  - 色点 (tags 数量，颜色 = 第一个 tag 颜色)
  - 星标 (flags.mastery, 1~3 星)
  - 笔记图标 (note 是否非空)
       │
       ├── hover Badge → 浮窗预览
       │   (note 全文 + tags + flags + relations 列表)
       │
       ├── click Badge → 打开 MarkVault 侧栏
       │   (定位到对应批注条目，高亮选中)
       │
       └── 右键节点 "批注此节点"
           → 调用 MarkVault createAnnotation API
           → 自动插入 %%markvault%% 锚点到 MD
```

### 5.2 反向联动

- MarkVault 批注变更 → 触发 `AnnotationStore.on('change')` → 刷新对应节点 Badge
- 标注删除 → 移除 Badge（不删除节点本身）

### 5.3 MarkVault API 依赖

```typescript
// 需要从 MarkVault 暴露的 API
interface MarkVaultAPI {
  getAnnotationsByFile(filePath: string): Annotation[];
  getAnnotationsByLine(filePath: string, line: number): Annotation[];
  getAnnotation(uuid: string): Annotation | null;
  createAnnotation(params: CreateAnnotationParams): Promise<Annotation>;
  onAnnotationChange(handler: (event: AnnotationChangeEvent) => void): void;
}
```

如果 MarkVault 未安装或未启用，MindFlow 正常运行（无 Badge 功能）。

---

## 6. 视觉增强

### 6.1 语义着色

复用 MarkVault 的 SEMANTIC_GROUPS 调色板，按批注的 `motivation` 字段自动着色节点边框：

| motivation | 维度 | 节点边框色 |
|------------|------|-----------|
| classifying / identifying | Taxonomic | indigo (#534AB7) |
| questioning / assessing | Argumentative | green (#3B6D11) |
| explaining / linking | Expository | amber (#BA7517) |
| referencing | Referential | cyan (#0F6E56) |
| comparing | Comparative | blue (#185FA5) |
| hypothesizing / predicting | Dynamic | teal (#0F6E56) |

无批注节点 = 默认灰色边框。

### 6.2 智能连线样式

| 关系类型 | 连线样式 |
|---------|---------|
| 父子（树结构） | 实线，灰色 |
| 跨节点关联 (MarkVault relation) | 虚线，颜色 = 关系类型色 |
| 双向关系 | 弧线 (curvature > 0) |
| 同向多关系 | 曲率分离 (复用 computeCurvature) |

### 6.3 学习状态可视化

| flags 字段 | 视觉效果 |
|-----------|---------|
| mastery (1~3) | 边框粗细 1px → 3px，颜色加深 |
| needsCorrection | 红色虚线边框 |
| reviewPriority (high) | 橙色角标 |
| confidence (low) | 节点半透明 (opacity: 0.7) |

### 6.4 多种布局主题

| 布局 | 描述 | 实现 |
|------|------|------|
| 右侧树 | 根节点左侧，子节点向右展开 | 默认 |
| 中心放射 | 根节点居中，子节点四周展开 | 角度分配算法 |
| 组织结构 | 根节点顶部，子节点向下展开 | 逐层水平排列 |
| 鱼骨图 | 分类节点左右交替排列 | 奇偶层方向反转 |

布局切换：CSS transition，所有节点同时 transform 到新位置，300ms ease-out。

### 6.5 聚焦模式

- 选中节点 → 同级和子级正常显示
- 其他子树 → `opacity: 0.15`
- 点击空白处 → 取消聚焦
- 折叠/展开 → `max-height` + `opacity` CSS transition

---

## 7. 命令与交互

### 7.1 命令列表

| 命令 | 快捷键 | 描述 |
|------|--------|------|
| `mindflow:open` | Ctrl+Shift+M | 打开当前文件的思维导图视图 |
| `mindflow:toggle-layout` | — | 切换布局主题 |
| `mindflow:focus-mode` | — | 切换聚焦模式 |
| `mindflow:collapse-all` | — | 折叠所有分支 |
| `mindflow:expand-all` | — | 展开所有分支 |
| `mindflow:annotate-node` | — | 批注当前选中节点（需 MarkVault） |
| `mindflow:export-svg` | — | 导出为 SVG |
| `mindflow:export-png` | — | 导出为 PNG |

### 7.2 节点交互

| 操作 | 效果 |
|------|------|
| 单击节点 | 选中，显示工具栏 |
| 双击节点 | 进入编辑模式 (contentEditable) |
| 右键节点 | 上下文菜单（编辑/删除/批注/添加子节点） |
| Tab | 在选中节点下添加子节点 |
| Enter | 在同级添加兄弟节点 |
| Delete | 删除节点（同时删除 MD 对应行） |
| Ctrl+Z | 撤销 |
| 拖拽节点 | 调整顺序/层级（修改 MD 结构） |

---

## 8. 文件结构

```
src/
  mindflow/                    # MindFlow 子模块
    types/
      mind-node.ts             # MindNode 数据类型
      layout-theme.ts          # 布局主题枚举
    data/
      md-parser.ts             # Markdown → MindNode 树解析
      tree-sync.ts             # 双向同步引擎
      markvault-bridge.ts      # MarkVault API 桥接
    layout/
      tree-layout.ts           # 树形布局算法
      radial-layout.ts         # 中心放射布局
      org-layout.ts            # 组织结构布局
      fishbone-layout.ts       # 鱼骨图布局
    render/
      node-renderer.ts         # 节点 DOM 渲染
      md-inline-renderer.ts    # MD 行内语法渲染器
      svg-connector.ts         # SVG 连线渲染
      badge-renderer.ts        # 批注 Badge 渲染
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

- [ ] MD Parser：标题 + 列表 → MindNode 树
- [ ] 右侧树布局 + SVG 贝塞尔连线
- [ ] 节点展示（纯文本，无 MD 渲染）
- [ ] Pan / Zoom
- [ ] 折叠 / 展开
- [ ] Tree ↔ MD 双向同步
- [ ] 命令: mindflow:open

### Phase 2: MD 渲染 + 编辑（1 周）

- [ ] MD Inline Renderer（bold/italic/code/link/highlight）
- [ ] contentEditable 编辑态切换
- [ ] LaTeX 渲染 (KaTeX)
- [ ] Tab / Enter / Delete 键盘交互
- [ ] 拖拽排序

### Phase 3: 批注联动（1 周）

- [ ] MarkVault Bridge API
- [ ] Annotation Badge 渲染
- [ ] Hover 浮窗预览
- [ ] 点击跳转侧栏
- [ ] 右键 "批注此节点"

### Phase 4: 视觉增强（1 周）

- [ ] 语义着色（motivation → 节点边框色）
- [ ] 智能连线样式
- [ ] 学习状态可视化
- [ ] 多布局主题切换
- [ ] 聚焦模式
- [ ] SVG/PNG 导出

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 大量节点 DOM 性能 | 500+ 节点卡顿 | Virtual Scroll + requestAnimationFrame 批量更新 |
| 双向同步冲突 | 数据丢失 | LWW + 500ms debounce + Obsidian 原生 undo |
| Markdown 列表解析 | 嵌套列表/多行列表项解析复杂 | Phase 1 仅支持单行列表项，多行 Phase 2+ |
| MarkVault API 不稳定 | 批注联动失效 | 优雅降级：MarkVault 不可用时无 Badge，核心功能正常 |
| contentEditable 兼容性 | 移动端/不同浏览器行为差异 | Phase 1 仅桌面端，移动端 Phase 4+ |
