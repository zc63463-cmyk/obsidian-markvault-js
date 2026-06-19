# MindFlow v3.1 导图编辑交接规划文档

> **用途**：新对话开发者基于此文档 + 项目代码库，直接开始 MindFlow 导图编辑 Phase 1 开发。
> **范围**：仅导图编辑本身（MD-Seed + Free 节点）。标注功能放在 PDF 扩展之后。
> **前置状态**：S0-S3 + 关系系统审查 + 反向关系构建器重构全部完成。架构基线干净。
> **日期**：2026-06-18

---

## 一、项目现状速览

### 已就绪（无需重做）

| 组件 | 状态 | 位置 |
|------|------|------|
| `MindmapSelector` 类型 | ✅ 已定义 | `src/types/annotation.ts:71-77` |
| `DocType = 'markdown' \| 'pdf' \| 'mindmap'` | ✅ 已定义 | `src/types/annotation.ts:29` |
| `Annotation.docType?` / `selector?` / `nodeId?` / `annotationRef?` | ✅ 已加 | `src/types/annotation.ts:137-145` |
| `byNodeId` 索引 + `getAnnotationsByNodeId()` | ✅ 已实现 | `src/db/index-layer.ts` |
| `byAnnotationRef` 反向索引 + `getMindmapRefs()` | ✅ 已实现 | `src/db/index-layer.ts` |
| `byDocType` 索引 | ✅ 已实现 | `src/db/index-layer.ts` |
| `AnnotationRenderer` 接口 + `RendererRegistry` | ✅ 已实现 | `src/core/renderer.ts` |
| 统一 logger 模块 | ✅ 已实现 | `src/utils/logger.ts` |

### 验证基线

- `tsc -noEmit` → exit 0
- `npm test` → 18 文件 576 用例全绿
- `esbuild` → 零警告

---

## 二、MindmapSelector 实际定义（以代码为准）

```typescript
// src/types/annotation.ts

/** MindMap 导图定位器 — 基于节点 ID */
export interface MindmapSelector extends BaseSelector {
  type: 'mindmap';       // Selector 类型标识
  nodeId: string;        // 导图节点 ID
  nodePath?: string;     // 节点路径（如 "root/数学/线性代数"），用于显示
}
```

**与设计文档的差异**（开发者必知）：
- 设计文档写的 `type: 'node' | 'group'` 和 `nodeIds?: string[]`（选框），**实际代码已简化**
- `type` 统一为 `'mindmap'`，不再区分 node/group
- `filePath` 不在 Selector 内，用 Annotation 顶层的 `filePath` 字段
- Annotation 顶层有冗余字段 `nodeId?` 和 `annotationRef?`（方便索引）

**Phase 1 不使用 MindmapSelector**（不涉及标注），但基础设施已就绪，Phase 3 接入标注时直接可用。

---

## 三、技术方案：DOM-Flow

放弃 Canvas/WebGL，采用 **DOM 节点 + SVG 连线 + CSS 弹性布局**：

| 选择 | 理由 |
|------|------|
| DOM 节点 | contentEditable 编辑零摩擦，MD 渲染零桥接 |
| SVG 连线 | 复用 MarkVault `computeCurvature`，支持虚线/颜色/箭头/曲率 |
| CSS 动画 | 折叠/展开/布局切换 transition，无需动画引擎 |
| 性能目标 | 500 节点内流畅（超出需虚拟化滚动） |

**不引入** ProseMirror / CodeMirror / 虚拟 DOM 库。

---

## 四、数据模型

### 独立 .md 文件作为导图载体

导图是独立的 .md 文件（不是把当前文件映射成导图），不依赖 MarkVault 也可独立使用。

### 三种节点类型

| 类型 | 来源 | 存储 | 视觉 | Phase |
|------|------|------|------|-------|
| **MD-Seed** | .md 标题/列表（只读种子） | .md 正文 | 实线边框 | Phase 1 ✅ |
| **Free** | 用户手动创建 | frontmatter JSON | 实线+"F"角标 | Phase 1 ✅ |
| **Annotation** | MarkVault 批注引用 | MarkVault Store | 虚线+批注图标 | Phase 3+ |

### 存储规则

- `.md` 正文（标题+列表）→ MD-Seed 节点，单向映射（MD 编辑→重新解析→更新导图）
- frontmatter `mindmap.nodes` → Free 节点 + Annotation 节点元数据
- 编辑 MD-Seed → 同步改 .md 正文；编辑 Free → 同步改 frontmatter

### frontmatter 结构示例

```yaml
---
mindmap:
  structureType: skeleton    # 认知结构类型
  layout: tree-right         # 布局类型（Phase 1 仅 tree-right）
  nodes:                     # Free 节点（MD-Seed 不存这里）
    - id: "free-1"
      parentId: "md-h2"     # 可挂在 MD-Seed 节点下
      text: "用户手动添加的节点"
      note: ""
---
```

### structureType 字段（认知结构类型）

标记用户当时的认知意图，与视觉 `layout` 可独立配置：

| structureType | 认知模式 | 典型场景 |
|--------------|---------|---------|
| `flow` | 步骤先后 | 解题步骤、推导链 |
| `skeleton` | 体系归属 | 章节复习、知识骨架 |
| `hierarchy` | 分类包含 | 分类整理 |
| `process` | 认知路径 | 解题路径复盘 |
| `fishbone` | 因果归因 | 错题分析、问题诊断 |
| `freeform` | 自由混合 | 不拘泥单一结构 |

**Phase 1 预留字段但只实现 `tree-right` 布局**，其余布局算法后续 Phase 做。

---

## 五、Phase 1 开发范围（MVP，2 周）

### 目标
在独立 .md 文件上实现"右侧树形导图编辑器"：解析 .md 标题/列表为只读 MD-Seed 节点，允许用户添加 Free 节点（存 frontmatter），支持 Pan/Zoom/折叠展开。

### 核心任务

| # | 任务 | 新增文件 | 说明 |
|---|------|---------|------|
| 1 | **MindNode 数据结构** | `src/mindflow/types/mind-node.ts` | 节点树结构定义（id/parentId/text/note/type/children） |
| 2 | **MD Parser** | `src/mindflow/data/md-parser.ts` | .md 标题+列表 → MindNode 树（MD-Seed 节点）。Phase 1 核心。 |
| 3 | **Frontmatter 读写** | `src/mindflow/data/frontmatter-sync.ts` | 读写 Free 节点到 frontmatter `mindmap.nodes`。Phase 1 核心。 |
| 4 | **MD-Seed 单向映射** | `src/mindflow/data/seed-sync.ts` | MD 编辑→重新解析→更新导图。Phase 1 核心。 |
| 5 | **右侧树布局** | `src/mindflow/layout/tree-layout.ts` | 计算节点 x/y 位置。Phase 1 核心。 |
| 6 | **节点 DOM 渲染** | `src/mindflow/render/node-renderer.ts` | 纯文本节点 DOM（无 MD 渲染，Phase 2 做）。Phase 1 核心。 |
| 7 | **SVG 连线** | `src/mindflow/render/svg-connector.ts` | 贝塞尔曲线连线。Phase 1 核心。 |
| 8 | **主视图** | `src/mindflow/view/mindflow-view.ts` | ItemView 子类，注册 `mindflow:view`。Pan/Zoom/折叠展开。Phase 1 核心。 |
| 9 | **命令注册** | `src/main.ts` (改动) | `mindflow:create` 创建导图文件 + `mindflow:open` 打开导图视图。 |

### 不做（明确排除）

| 排除项 | Phase |
|--------|-------|
| MD Inline 渲染（bold/italic/code/LaTeX） | Phase 2 |
| contentEditable 编辑态切换 | Phase 2 |
| 标注系统接入（方案B/批注子节点/选框） | Phase 3+ |
| 语义着色/学习状态可视化 | Phase 4 |
| 多布局主题（fishbone/process 等） | Phase 4 |
| 导出（PNG/SVG/OPML） | Phase 4 |
| `%%mv:i%%` 锚点隐身处理 | Phase 2 |

---

## 六、文件结构

```
src/mindflow/
  types/
    mind-node.ts              # Phase 1: MindNode 数据结构
  data/
    md-parser.ts              # Phase 1: Markdown → MindNode 树
    frontmatter-sync.ts       # Phase 1: 读写 Free 节点
    seed-sync.ts              # Phase 1: MD-Seed 单向映射
  layout/
    tree-layout.ts            # Phase 1: 右侧树布局算法
  render/
    node-renderer.ts          # Phase 1: 节点 DOM 渲染（纯文本）
    svg-connector.ts          # Phase 1: SVG 贝塞尔连线
  view/
    mindflow-view.ts          # Phase 1: 主视图 (ItemView)
```

---

## 七、MindNode 数据结构建议

```typescript
/** 导图节点类型 */
export type MindNodeType = 'md-seed' | 'free' | 'annotation';

/** 导图节点 */
export interface MindNode {
  /** 唯一 ID（MD-Seed 用 md-前缀+行号，Free 用 uuid，Annotation 用 ann-前缀+uuid） */
  id: string;
  /** 父节点 ID（根节点为 null） */
  parentId: string | null;
  /** 节点类型 */
  type: MindNodeType;
  /** 显示文本 */
  text: string;
  /** 备注（Free 节点有，MD-Seed 从 .md 提取或留空） */
  note?: string;
  /** 子节点（布局计算后填充） */
  children: MindNode[];
  /** 布局计算结果 */
  layout?: { x: number; y: number; width: number; height: number };
  /** 折叠状态 */
  collapsed?: boolean;
  /** MD-Seed 专用：来源行号 */
  sourceLine?: number;
  /** MD-Seed 专用：标题级别（1-6）或列表层级 */
  sourceLevel?: number;
}
```

---

## 八、关键技术决策

### 8.1 MD-Seed 解析规则

| Markdown 元素 | 导图节点 |
|--------------|---------|
| `# 标题` | level 1 根节点 |
| `## 标题` | level 2 子节点 |
| `### 标题` | level 3 孙节点 |
| `- 列表项` | 列表层级节点（缩进决定层级） |
| 正文段落 | 不解析为节点（忽略） |
| 代码块 | 不解析为节点（忽略） |

### 8.2 Free 节点挂载

Free 节点可挂载在任意 MD-Seed 节点下（通过 `parentId` 关联）。frontmatter 存储 `parentId`，布局时将 Free 节点插入对应 MD-Seed 的 children 中。

### 8.3 布局算法（右侧树）

```
root → 右侧展开
  child1 → 再右侧展开
    grandchild1
  child2
    grandchild2
```

- 水平间距：每层级 180px
- 垂直间距：节点高度 + 20px
- 节点高度：单行 32px，多行按行数计算
- 折叠：collapsed=true 的节点不渲染 children

### 8.4 SVG 连线

贝塞尔曲线从父节点右侧中点 → 子节点左侧中点：
```
M (x1, y1) C (x1 + dx, y1), (x2 - dx, y2), (x2, y2)
```
其中 `dx = (x2 - x1) * 0.5`。

---

## 九、测试要求

### 新建 `tests/mindflow-basic.test.ts`

```
✅ MD Parser: # 标题 → level 1 根节点
✅ MD Parser: ## 标题 → level 2 子节点
✅ MD Parser: - 列表项 → 列表节点
✅ MD Parser: 正文段落 → 不生成节点
✅ MD Parser: 嵌套列表 → 正确的父子关系
✅ Frontmatter: 写入 Free 节点 → frontmatter JSON 正确
✅ Frontmatter: 读取 Free 节点 → 还原 MindNode
✅ Frontmatter: 混合 MD-Seed + Free → 合并为完整树
✅ seed-sync: MD 编辑 → 重新解析 → Free 节点保留
✅ tree-layout: 单根树 → 正确的 x/y 位置
✅ tree-layout: 折叠节点 → children 不参与布局
```

---

## 十、验证清单

开发完成后验证：
- [ ] `tsc -noEmit` → exit 0
- [ ] `npm test` → 全部通过（含新增 MindFlow 测试）
- [ ] `esbuild` → 零警告
- [ ] `mindflow:create` 命令 → 创建 .md 文件 + 打开导图视图
- [ ] .md 标题 → 导图节点正确显示
- [ ] .md 列表 → 导图节点正确显示
- [ ] 添加 Free 节点 → frontmatter 写入
- [ ] 关闭重开 → Free 节点保留
- [ ] 编辑 .md 标题 → 导图更新
- [ ] Pan / Zoom 正常
- [ ] 折叠 / 展开 正常

---

## 十一、参考文档

- 完整设计：`docs/specs/2026-06-17-mindflow-mindmap-design.md`（v3.1 方案）
- Obsidian Vault：`E:\Notes\DevNotes\Markvault-js开发\MindFlow\`

---

## 十二、约定

- 用 `logger.debug()` 替代 `console.log()`
- 新增字段到 `Annotation` 接口时，**必须同步更新三处**：`strip-fields.ts` 白名单 + W3C 序列化器 + 索引层
- 测试用 `tsx` 运行器，与现有 18 个测试文件一致
- `npm test` 已包含全部 18 个测试文件，新增测试需补入 package.json
- **Phase 1 不碰标注系统**——导图标注功能放在 PDF 扩展之后
- MindmapSelector / byNodeId / byAnnotationRef 索引已就绪但 Phase 1 不主动使用，仅为 Phase 3+ 铺路
