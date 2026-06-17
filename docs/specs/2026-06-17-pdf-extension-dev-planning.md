# MarkVault PDF 标注扩展 — 功能开发前置规划

> 日期: 2026-06-17 | 版本: v1.0 | 状态: DRAFT
>
> 关联文档:
> - 可行性研究: `docs/pdf-extension-feasibility.md`
> - 认知系统评测: `docs/cognitive-system-validation.md`
> - 三模块协同: `docs/mindflow-integration-analysis.md`
> - MindFlow spec: `docs/specs/2026-06-17-mindflow-mindmap-design.md`

---

## 1. 战略定位与核心命题

### 1.1 一句话定位

**PDF 扩展 = MarkVault 的输入维度扩展**——从"在 Markdown 上深度标注"升级到"在原文(MD+PDF)上深度标注"，打通"原文学习 + 笔记学习"的知识闭环。

### 1.2 规划体系中的角色

```
        MarkVault 核心（认知数据引擎）
         /        |         \
        /         |          \
   PDF 扩展    RelationGraph   MindFlow
  （输入扩展）  （关系网络底座）  （主动梳理工具）
        \         |          /
         \        |         /
          AI Agent（智能扩展）
```

- **PDF 扩展**: 增加"原文标注"输入维度，让学术教材/论文可以直接深度标注
- **与 RelationGraph**: PDF 标注直接接入 25 种关系系统，原文定理 → elaborates → MD 理解笔记
- **与 MindFlow**: 共享 docType 基础设施，选框标注复用 PDF 区域标注架构（仅 20% 额外成本）
- **与 AI Agent**: PDF 标注数据提供"原文理解偏差"的检测信号源

### 1.3 差异化竞争力

**MarkVault 是唯一能提供"PDF 标注 × 语义关系 × 学习状态"的 Obsidian 插件**。

| 维度 | PDF++ | Annotator | Zotero | Hypothesis | **MarkVault PDF** |
|------|-------|-----------|--------|------------|-------------------|
| 关系系统 | ✗ | ✗ | ✗ | ✗ | **25 种语义关系** |
| 学习状态 | ✗ | ✗ | ✗ | ✗ | **mastery/confidence/SRS** |
| 跨文档关系 | 部分 | ✗ | ✗ | ✗ | **PDF↔MD 完整打通** |
| W3C 标准 | ✗ | ✗ | ✗ | ✓ | **✓ + FragmentSelector/SvgSelector** |
| 非破坏性 | ✓ | ✗ | ✓ | ✓ | **✓ 反向链接存储** |

---

## 2. 当前系统架构审查摘要

### 2.1 通用层复用度

**70% 代码直接复用**（零改动）:

| 可复用模块 | 文件 | 原因 |
|-----------|------|------|
| RelationSchema + RelationEngine | `annotation.ts` / `relation-engine.ts` | 关系系统与文档类型正交 |
| AnnotationFlag / MasteryLevel / ReviewPriority | `annotation.ts` | 学习状态与文档类型正交 |
| AnnotationMotivation / inferMotivation() | `annotation.ts` | 标注意图与文档类型正交 |
| computeCurvature() + deduplicateLinks() | `graph-data-builder.ts` | 图论算法与标注类型无关 |
| buildAnnotation() / finalizeAnnotation() | `core/annotation-creator.ts` | 只需扩展 params，核心逻辑通用 |
| FormatRegistry 注册/路由机制 | `format-registry.ts` | 注册新 PdfFormat 即可自动路由 |
| W3C 序列化/反序列化框架 | `w3c-serializer.ts` | 只需新增 PDF selector 分支 |
| PersistLayer 分片读写 | `persist-layer.ts` | filePath 已是 string，PDF 路径自动适配 |
| 搜索引擎 + 过滤引擎 | `search/` 目录 | 文本搜索与文档类型正交 |
| 13 个倒排索引 | `index-layer.ts` | `_byKind` 是 `Map<string, Set<string>>`，新 kind 自动可用 |

### 2.2 需扩展的锚点（精确到文件和行号）

| 修改项 | 文件 | 当前值 | 扩展为 |
|--------|------|--------|--------|
| Annotation.kind | `types/annotation.ts:37` | `'inline' \| 'block' \| 'span' \| 'region'` | + `'pdf-highlight' \| 'pdf-area' \| 'pdf-ink'` |
| Annotation.docType | `types/annotation.ts` | **不存在** | 新增 `'markdown' \| 'pdf'` |
| Annotation.pdfSelector | `types/annotation.ts` | **不存在** | 新增 `PDFSelector` 接口 |
| Annotation.previewImage | `types/annotation.ts` | **不存在** | 新增 `string` (base64) |
| Annotation.format | `types/annotation.ts:53` | `'mark' \| 'native'` | + `'pdf'` |
| AnnotationFilter.docType | `types/annotation.ts:568-585` | **不存在** | 新增 `'markdown' \| 'pdf' \| 'all'` |
| AnnotationFormat.id | `format-interface.ts:50` | `'mark' \| 'native' \| 'block' \| 'span' \| 'region'` | + `'pdf'` |
| resolveFormat() | `format-registry.ts:115-133` | 4 分支 | + PDF kind 分支 |
| buildTarget() | `w3c-serializer.ts:215-264` | MD selector 逻辑 | + PDF FragmentSelector/SvgSelector |
| IndexLayer._byDocType | `index-layer.ts` | **不存在** (13 索引) | 新增第 14 索引 |
| IndexLayer._byPage | `index-layer.ts` | **不存在** | 新增页码索引（PDF 专用） |
| KIND_COLORS | `graph-data-builder.ts:63-68` | 4 种 | + pdf-highlight / pdf-area / pdf-ink |
| createReadingAnnotation() | `plugin/annotation-creator.ts` | MD 写入流程 | + PDF 分支（不写 MD，直接写 Store） |

---

## 3. 核心数据模型设计

### 3.1 Annotation 接口扩展

```typescript
// ── 现有字段保持不变 ──────────────────────
interface Annotation {
  uuid: string;
  filePath: string;           // "notes/ch1.md" 或 "books/textbook.pdf"
  type: AnnotationType;       // 'highlight' | 'bold' | 'underline'
  kind?: AnnotationKind;      // 扩展后含 PDF kind

  // ── 新增: 文档类型路由 ──────────────────
  docType?: 'markdown' | 'pdf';  // 默认 'markdown'，PDF 标注设为 'pdf'

  // ── 新增: PDF 专有定位 ──────────────────
  pdfSelector?: PDFSelector;

  // ── 新增: PDF 区域预览 ──────────────────
  previewImage?: string;      // base64 data URL，可选

  // ── 其余字段 100% 保留 ──────────────────
  text: string;               // PDF.js 提取的文本内容
  note: string;
  color: string;
  tags: string[];
  relations?: AnnotationRelation[];
  flags?: AnnotationFlag;
  motivation?: AnnotationMotivation;
  // ...
}

// ── AnnotationKind 扩展 ──────────────────
type AnnotationKind =
  | 'inline' | 'block' | 'span' | 'region'     // MD 标注（现有）
  | 'pdf-highlight' | 'pdf-area' | 'pdf-ink';   // PDF 标注（新增）
```

### 3.2 PDFSelector 定位模型

```typescript
interface PDFSelector {
  page: number;               // 1-索引页码

  // ── 文本高亮定位 ────────────────────────
  selection?: {
    startIdx: number;         // PDF.js textLayer 起始 span 索引
    startOff: number;         // 起始 span 内字符偏移
    endIdx: number;           // PDF.js textLayer 结束 span 索引
    endOff: number;           // 结束 span 内字符偏移
  };

  // ── 多行高亮矩形（viewport 坐标 → 归一化） ──
  rects?: Array<{
    x: number;                // 归一化 0.0-1.0 (左)
    y: number;                // 归一化 0.0-1.0 (底，PDF 空间)
    width: number;            // 归一化 0.0-1.0
    height: number;           // 归一化 0.0-1.0
  }>;

  // ── 矩形区域标注 ────────────────────────
  areaRect?: {
    x: number; y: number;     // 归一化坐标
    width: number; height: number;
  };

  // ── 自由画笔 ────────────────────────────
  svgPath?: string;           // SVG path data（归一化坐标）

  // ── 跨页区域（Phase 3）──────────────────
  endPage?: number;
  endRect?: { x: number; y: number; width: number; height: number };
}
```

### 3.3 定位策略：双定位模式

PDF 标注的定位比 MD 标注**更简单稳定**（永不漂移），但需要双定位以保证鲁棒性：

| 定位层 | 作用 | 格式 | 依赖 |
|--------|------|------|------|
| **主定位: selection** | 精确到字符的文本定位 | `{startIdx, startOff, endIdx, endOff}` | PDF.js textLayer（同 PDF 文件，稳定） |
| **辅助定位: rects** | 渲染高亮覆盖层 | 归一化 `{x, y, w, h}` 矩形列表 | PDF 页面尺寸（固定不变） |
| **文本内容: text** | 搜索/关系/预览 | 从 PDF.js `getTextContent()` 提取 | 实时提取，创建时缓存 |
| **可视化: previewImage** | 侧边栏/图谱预览 | canvas 截图 base64（可选） | 当前 viewport（缩放无关） |

**与 MD 标注定位对比**:

| 维度 | MD 标注 | PDF 标注 |
|------|---------|---------|
| 位置稳定性 | 可漂移（编辑导致偏移变化） | **固定（页面布局永不变）** |
| 漂移恢复 | 必需（targetHash + TextQuoteSelector） | **不需要** |
| 文本获取 | 直接从 MD 源码截取 | PDF.js textLayer 提取 |
| 区域标注 | 行号范围 | 归一化坐标矩形 |

### 3.4 W3C Selector 映射

PDF 标注到 W3C Web Annotation 的完整映射：

| PDF 标注类型 | W3C Selector 组合 | 示例 |
|-------------|-------------------|------|
| 文本高亮 | FragmentSelector(`page=N`) **refinedBy** TextQuoteSelector | `page=5` + `exact="theorem 3.2"` |
| 矩形区域 | FragmentSelector(`page=N`) **refinedBy** SvgSelector(`<rect>`) | `page=5` + `<rect x="0.12" y="0.35" ...>` |
| 自由画笔 | FragmentSelector(`page=N`) **refinedBy** SvgSelector(`<path>`) | `page=5` + `<path d="M0.1,0.2 ..."/>` |
| 跨页区域 | RangeSelector(FragmentSelector₁, FragmentSelector₂) | `page=5..7` |

---

## 4. 标注形式详细设计

### 4.1 PDF 文本高亮（PDFHighlight）— 可行性 ★★★★★

**实现路径**: 复用 PDF.js 的 textLayer

```
PDF.js 渲染 PDF → 生成 textLayer (span 元素层)
→ 用户选中文本 → 获取 selection(startIdx, startOff, endIdx, endOff)
→ 创建高亮 overlay (CSS background-color 半透明矩形)
→ 通过 PDF.js getTextContent() 提取文本 → 存入 annotation.text
→ 存储: page + selection + rects(归一化)
```

**核心优势**:
- PDF.js 的 textLayer 索引是**稳定的**（同 PDF 文件，文本结构不变）
- 比 MD 标注更简单——**不需要漂移恢复机制**
- textLayer `<span>` 元素可以直接用 CSS background-color 做高亮渲染

**交互设计**:
- 用户在 PDF 视图中选中文本 → 右键菜单 / 快捷键 → 创建高亮标注
- 高亮颜色: 复用 `PRESET_COLORS`（与 MD 标注完全一致）
- 侧边栏显示: 标注列表 + 文本预览 + 可选截图预览

### 4.2 矩形区域标注（PDFArea）— 可行性 ★★★★

**实现路径**: SVG overlay + 归一化坐标

```
用户拖拽矩形 → 获取 viewport 坐标 {x, y, width, height}
→ viewport.convertToPDFPoint() 转为 PDF 空间坐标
→ 归一化 (除以页面宽高) → 存储 {x: 0.12, y: 0.35, w: 0.45, h: 0.08}
→ 渲染时 viewport.convertToViewportPoint() 还原
→ 可选: canvas.toDataURL() 截取区域预览
```

**坐标转换关键**:

| 坐标系 | 原点 | Y轴方向 | 单位 |
|--------|------|--------|------|
| PDF 空间 | 左下角 | 向上 ↑ | pt (1/72 inch) |
| Viewport | 左上角 | 向下 ↓ | px |
| 归一化 | 左下角 | 向上 ↑ | 0.0-1.0 (比例) |

**存储使用归一化坐标的理由**:
- 与缩放/视口大小无关——打开 PDF 时任何缩放级别都能正确还原
- 与 PDF.js 版本无关——页面尺寸是 PDF 文件固有的
- 与 Obsidian 版本无关——坐标不依赖任何私有 API

### 4.3 自由画笔（PDFInk）— 可行性 ★★★

**实现路径**: SVG path + 归一化 + Douglas-Peucker 压缩

```
用户自由画笔 → 记录鼠标轨迹点序列
→ viewport → PDF 空间 → 归一化坐标
→ Douglas-Peucker 算法压缩 (阈值 0.002)
→ 生成 SVG path data → 存储为 annotation.pdfSelector.svgPath
→ 渲染: SVG overlay 绘制 path
```

**挑战与缓解**:
- 数据量较大 → Douglas-Peucker 压缩可减 70-80% 点数
- 渲染性能 → 分页懒加载，仅渲染当前可见页
- 笔画平滑 → 可选 Catmull-Rom 插值

---

## 5. 存储与跳转设计

### 5.1 存储策略: 反向链接模式（不修改 PDF）

**与现有架构完全一致**——PDF 标注的分片存储逻辑与 MD 标注完全相同：

```
.obsidian/plugins/markvault-js/annotations/
  └── {b64(book.pdf)}.json     ← PDF 标注分片，格式与 MD 标注分片完全相同
```

标注数据存储在 MarkVault 的 JSON 分片中，**不写入 PDF 文件本身**。

**核心优势**:
- 与现有 PersistLayer **零改动** — filePath="book.pdf" 自动映射到分片
- 非破坏性 — PDF 文件不变，适合学术场景
- 版本控制友好 — 标注数据与 PDF 文件分离
- 反向链接天然支持 — 打开 PDF 时自动加载对应标注

### 5.2 跳转机制

```
用户点击标注条目
→ 读取 filePath("book.pdf") + pdfSelector.page + selection/rect
→ Obsidian openFile("book.pdf") → PDF 视图打开
→ 监听 PDF viewer loaded 事件
→ 调用 PDFViewerApplication.pdfViewer.scrollPageIntoView({
    pageNumber: page,
    destArray: [page, "FitR", ...rect]
  })
→ 渲染高亮 overlay 在目标位置
```

**关键技术路径**:
1. Obsidian 的 PDF 视图基于 PDF.js，支持 `#page=N` 子路径
2. 通过 `PDFViewerChild` API 访问 PDF.js 内部状态
3. `scrollPageIntoView()` 实现精确页面定位
4. 高亮 overlay 在 PDF viewer 加载后异步渲染

### 5.3 关系跳转: PDF↔MD 跨文档

```
侧边栏/RelationGraph 点击 PDF 标注 → 跳转到 PDF 页面位置
侧边栏/RelationGraph 点击 MD 标注 → 跳转到 MD 文件偏移位置
跨文档关系: PDF定理 → elaborates → MD笔记 → 跳转任意端
```

**docType 路由机制**: 根据标注的 `docType` 字段决定跳转行为:
- `docType='markdown'` → 打开 CM6 编辑器，定位到偏移
- `docType='pdf'` → 打开 PDF viewer，定位到页码+坐标

---

## 6. PDF Viewer Overlay 渲染架构

### 6.1 渲染层设计

PDF viewer 的标注渲染采用 **SVG overlay 层**，与 PDF.js textLayer 并行：

```
┌─ Obsidian PDF 视口 ──────────────────────┐
│  PDF.js canvas (底层)                      │
│  PDF.js textLayer (文本层, <span> 元素)     │
│  MarkVault SVG overlay (标注渲染层)         │ ← 新增
│    ├── 高亮矩形 (<rect> 半透明填充)        │
│    ├── 区域标注 (<rect> 虚线边框)          │
│    ├── 画笔标注 (<path> SVG 路径)          │
│    └── 标注图标 (<circle>+<text> 标记)     │
│  MarkVault 交互层 (鼠标事件拦截)            │ ← 新增
└──────────────────────────────────────────┘
```

**渲染策略**:
- 分页懒加载: 仅渲染当前可见页 + 前后各 1 页的标注
- 高亮优先级: pdf-highlight > pdf-area > pdf-ink（避免遮挡）
- 缩放同步: viewport 变化时重新计算 viewport 坐标

### 6.2 与 PDF.js 的交互接口

```typescript
// 获取 PDF viewer 状态
interface PDFViewerBridge {
  // 获取 PDFViewerApplication 实例
  getApp(): PDFViewerApplication;

  // 获取指定页的 viewport
  getPageViewport(page: number): PDFPageViewport;

  // 获取指定页的 textLayer 内容
  getTextContent(page: number): TextContent;

  // 坐标转换: viewport → PDF 空间 → 归一化
  convertToNormalized(page: number, viewportX: number, viewportY: number): {x: number, y: number};

  // 坐标转换: 归一化 → PDF 空间 → viewport
  convertFromNormalized(page: number, normX: number, normY: number): {x: number, y: number};

  // 跳转到指定页面和位置
  scrollToPosition(page: number, rect?: NormalizedRect): void;

  // 监听 PDF viewer 事件
  onViewerLoaded(callback: () => void): void;
  onPageChanged(callback: (page: number) => void): void;
}
```

### 6.3 文本提取流程

```typescript
// PDF.js 文本提取 → annotation.text
async function extractPDFText(page: number, selection: PDFSelection): string {
  const textContent = await pdfViewer.getPageTextContent(page);
  const spans = textContent.items;
  // 按 selection 范围截取文本
  let text = '';
  for (let i = selection.startIdx; i <= selection.endIdx; i++) {
    const span = spans[i];
    if (i === selection.startIdx && i === selection.endIdx) {
      text += span.str.substring(selection.startOff, selection.endOff);
    } else if (i === selection.startIdx) {
      text += span.str.substring(selection.startOff);
    } else if (i === selection.endIdx) {
      text += span.str.substring(0, selection.endOff);
    } else {
      text += span.str;
    }
  }
  return text.trim();
}
```

---

## 7. 索引层扩展设计

### 7.1 新增索引

从 13 索引扩展到 **15 索引**:

| 新索引 | 类型 | 用途 |
|--------|------|------|
| `_byDocType` | `Map<string, Set<string>>` | 按文档类型过滤 (`'markdown'` / `'pdf'`) |
| `_byPage` | `Map<number, Map<number, Set<string>>>` | 按文件+页码索引 PDF 标注 |

**_byPage 结构说明**: 外层 Map key = filePath hash，内层 Map key = 页码，value = 该页所有标注 UUID。

### 7.2 索引维护逻辑

```typescript
// addToIndex 新增分支
addToIndex(annotation: Annotation): void {
  // ... 现有 13 索引维护逻辑不变 ...

  // 新增: docType 索引
  const docType = annotation.docType || 'markdown';
  this._byDocType.getOrSet(docType).add(annotation.uuid);

  // 新增: 页码索引 (仅 PDF 标注)
  if (annotation.docType === 'pdf' && annotation.pdfSelector) {
    const fileKey = hashFilePath(annotation.filePath);
    const pageMap = this._byPage.getOrSet(fileKey);
    const pageSet = pageMap.getOrSet(annotation.pdfSelector.page);
    pageSet.add(annotation.uuid);
  }
}
```

### 7.3 QueryEngine 扩展

```typescript
// AnnotationFilter 新增字段
interface AnnotationFilter {
  // ... 现有字段 ...
  docType?: 'markdown' | 'pdf' | 'all';   // 新增
  page?: number;                           // 新增: 页码过滤
}

// QueryEngine 新增索引过滤路径
if (filter.docType && filter.docType !== 'all') {
  const docTypeSet = this.indexLayer.byDocType.get(filter.docType);
  if (docTypeSet) candidates = candidates.intersect(docTypeSet);
}

if (filter.page && filter.filePath) {
  const fileKey = hashFilePath(filter.filePath);
  const pageMap = this.indexLayer.byPage.get(fileKey);
  if (pageMap) {
    const pageSet = pageMap.get(filter.page);
    if (pageSet) candidates = candidates.intersect(pageSet);
  }
}
```

---

## 8. Format 层扩展设计

### 8.1 PdfFormat 注册

```typescript
class PdfFormat implements AnnotationFormat {
  readonly id = 'pdf' as const;

  // PDF 标注不嵌入文件，所有方法返回空操作
  parse(content: string, filePath: string): ParsedAnnotation[] {
    // PDF 标注不从 Markdown 解析，返回空
    return [];
  }

  build(annotation: Annotation, content: string): string {
    // PDF 标注不修改源文件，返回原内容
    return content;
  }

  update(annotation: Annotation, content: string, updates: Partial<Annotation>): string | null {
    // PDF 标注属性更新直接通过 Store，不涉及源文件修改
    return null;
  }

  remove(annotation: Annotation, content: string): string | null {
    // PDF 标注删除直接通过 Store，不涉及源文件修改
    return null;
  }

  strip(content: string): string {
    // PDF 文件中没有标注标记，返回原内容
    return content;
  }
}
```

### 8.2 resolveFormat() 扩展

```typescript
// format-registry.ts resolveFormat() 扩展
private resolveFormat(annotation: Annotation): AnnotationFormat {
  if (annotation.format) {
    const format = this.formats.get(annotation.format);
    if (!format) throw new Error(`Unknown format: ${annotation.format}`);
    return format;
  }

  // 新增: PDF kind 路由
  if (annotation.kind === 'pdf-highlight'
      || annotation.kind === 'pdf-area'
      || annotation.kind === 'pdf-ink') {
    const pdfFormat = this.formats.get('pdf');
    if (!pdfFormat) throw new Error('PdfFormat not registered');
    return pdfFormat;
  }

  // 原有路由逻辑不变
  const id = annotation.kind === 'block' || annotation.kind === 'span' ? 'block'
           : annotation.kind === 'region' ? 'region'
           : 'mark';
  // ...
}
```

---

## 9. W3C 兼容层扩展设计

### 9.1 序列化: Annotation → W3C

```typescript
// buildTarget() 新增 PDF 分支
function buildTarget(annotation: Annotation): W3CTarget {
  if (annotation.docType === 'pdf') {
    return buildPDFTarget(annotation);
  }
  // ... 原有 MD 标注逻辑不变 ...
}

function buildPDFTarget(annotation: Annotation): W3CTarget {
  const selector = annotation.pdfSelector!;
  const selectors: W3CSelector[] = [];

  // 基础层: FragmentSelector (页码, RFC 3778)
  selectors.push({
    type: 'FragmentSelector',
    conformsTo: 'http://tools.ietf.org/rfc/rfc3778',
    value: `page=${selector.page}`
  });

  // 文本高亮 → refinedBy TextQuoteSelector
  if (selector.selection && annotation.text) {
    selectors.push({
      type: 'TextQuoteSelector',
      exact: annotation.text,
      prefix: '',   // PDF 上下文可选
      suffix: ''
    });
  }

  // 矩形区域 → refinedBy SvgSelector
  if (selector.areaRect) {
    const r = selector.areaRect;
    selectors.push({
      type: 'SvgSelector',
      value: `<svg:svg><svg:rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}"/></svg:svg>`
    });
  }

  // 画笔 → refinedBy SvgSelector (path)
  if (selector.svgPath) {
    selectors.push({
      type: 'SvgSelector',
      value: `<svg:svg><svg:path d="${selector.svgPath}"/></svg:svg>`
    });
  }

  return {
    source: annotation.filePath,
    format: 'application/pdf',
    selector: selectors
  };
}
```

### 9.2 反序列化: W3C → Annotation

```typescript
// W3C 导入时，识别 PDF 标注
function isPDFTarget(target: W3CTarget): boolean {
  return target.format === 'application/pdf'
    || target.selector?.some(s =>
        s.type === 'FragmentSelector' && s.conformsTo?.includes('rfc3778'));
}

// 从 W3C Selector 重建 PDFSelector
function parsePDFSelectors(selectors: W3CSelector[]): PDFSelector {
  const result: PDFSelector = { page: 1 };

  for (const s of selectors) {
    if (s.type === 'FragmentSelector' && s.conformsTo?.includes('rfc3778')) {
      const match = s.value.match(/page=(\d+)/);
      if (match) result.page = parseInt(match[1]);
    }
    if (s.type === 'SvgSelector') {
      // 解析 <rect> 或 <path>
      const rectMatch = s.value.match(/rect[^>]*x="([^"]*)"[^>]*y="([^"]*)"[^>]*width="([^"]*)"[^>]*height="([^"]*)"/);
      if (rectMatch) {
        result.areaRect = {
          x: parseFloat(rectMatch[1]),
          y: parseFloat(rectMatch[2]),
          width: parseFloat(rectMatch[3]),
          height: parseFloat(rectMatch[4])
        };
      }
      const pathMatch = s.value.match(/path[^>]*d="([^"]*)"/);
      if (pathMatch) {
        result.svgPath = pathMatch[1];
      }
    }
    if (s.type === 'TextQuoteSelector') {
      // 文本高亮标记（selection 需要在 PDF 打开时重建）
      // text 直接取 exact
    }
  }

  return result;
}
```

---

## 10. 创建流程设计

### 10.1 PDF 标注创建流程

```typescript
// plugin/annotation-creator.ts 新增分支
async function createPDFAnnotation(
  params: PDFAnnotationCreateParams
): Promise<Annotation> {

  // 1. 构建 Annotation 对象
  const annotation = buildAnnotation({
    ...params,
    docType: 'pdf',
    format: 'pdf',
    kind: params.pdfKind,   // 'pdf-highlight' | 'pdf-area' | 'pdf-ink'
    pdfSelector: params.pdfSelector,
  });

  // 2. PDF 标注不做 MD 写入！直接写 Store
  await finalizeAnnotation(annotation);

  // 3. 刷新侧边栏
  refreshSidebar(annotation.filePath);

  return annotation;
}

interface PDFAnnotationCreateParams extends AnnotationCreateParams {
  pdfKind: 'pdf-highlight' | 'pdf-area' | 'pdf-ink';
  pdfSelector: PDFSelector;
  previewImage?: string;      // 区域标注可选截图
}
```

### 10.2 PDF 文本高亮创建交互

```
1. 用户在 PDF 视图中选中一段文本
2. 触发创建: 右键菜单 / 快捷键 Ctrl+Shift+H
3. PDF viewer bridge 获取 selection 数据:
   - page: 当前页码
   - startIdx/startOff/endIdx/endOff: textLayer 索引
4. getTextContent() 提取选中文本 → annotation.text
5. viewport 坐标 → 归一化 → annotation.pdfSelector.rects
6. 弹出 AnnotationModal (复用现有 Modal 组件):
   - 选择 color (PRESET_COLORS)
   - 输入 note (可选)
   - 选择 motivation (推断默认值)
7. 创建 Annotation → 写入 Store → 渲染高亮 overlay
```

### 10.3 PDF 矩形区域标注创建交互

```
1. 用户点击"区域标注"工具按钮
2. PDF 视图进入矩形选择模式:
   - 鼠标变为十字准星
   - 拖拽绘制矩形
3. 释放鼠标 → 获取 viewport 矩形坐标
4. 归一化 → annotation.pdfSelector.areaRect
5. 可选: canvas 截图 → annotation.previewImage
6. 弹出 AnnotationModal
7. 创建 Annotation → 写入 Store → 渲染区域 overlay
```

---

## 11. 侧边栏与 UI 扩展设计

### 11.1 侧边栏 PDF 标注展示

**核心原则**: PDF 标注在侧边栏中与 MD 标注完全同构，只是预览方式不同：

| 标注类型 | 侧边栏预览 | 点击跳转 |
|---------|-----------|---------|
| MD inline/block/span | CM6 编辑器内高亮预览 | 打开 MD 文件定位偏移 |
| MD region | 区域文本摘要 | 打开 MD 文件定位行 |
| **PDF highlight** | **提取文本 + 可选截图** | **打开 PDF 跳转页码** |
| **PDF area** | **截图预览 + 文本(如有)** | **打开 PDF 跳转区域** |
| **PDF ink** | **SVG 缩略图** | **打开 PDF 跳转页码** |

### 11.2 PDF 标注列表过滤

侧边栏新增 docType 过滤控件:

```
[全部] [Markdown] [PDF] ← 新增 docType 过滤按钮组
```

点击 [PDF] → `AnnotationFilter.docType = 'pdf'` → QueryEngine 返回 PDF 标注子集。

### 11.3 PDF 视图中的标注工具栏

在 PDF 视图顶部新增浮动工具栏:

```
[📝 高亮] [🔲 区域] [🖊 画笔] [⚙ 设置] ← PDF 标注工具栏
```

- **高亮**: 选中文本 → 创建 PDFHighlight 标注
- **区域**: 拖拽矩形 → 创建 PDFArea 标注
- **画笔**: 自由画笔 → 创建 PDFInk 标注 (Phase 3)
- **设置**: PDF 标注相关设置面板

---

## 12. 关系系统复用设计

### 12.1 关系引擎零改动

PDF 标注的关系数据结构 **与 MD 标注完全相同**:

```typescript
interface AnnotationRelation {
  type: RelationType;           // 25 种语义关系，与 docType 无关
  targetUuid: string;           // 目标标注 UUID（可以是 MD 或 PDF）
  source?: 'manual' | 'template' | 'inferred' | 'imported';
  invalidAt?: string;           // 双时态关系失效时间
  note?: string;                // 关系备注
}
```

### 12.2 跨文档关系场景

```
PDF 教材 (原文)                     Markdown 笔记 (理解)
├── PDFHighlight: 定理3.2           ├── Inline: 我的推导过程
│   → elaborates →                  │   → applies → 定理3.2(PDF)
├── PDFHighlight: 公式推导          ├── Block: 代码示例
│   → precedes →                    │   → exemplifies → 公式推导(PDF)
└── PDFArea: 图3.1                  ├── Region: 章节总结
    → illustrates →                 │   → summarizes → 整章(PDF)
```

**跨文档关系链**:
```
PDF定理 → elaborates → MD理解 → proves → MD推论 → references → PDF另一处
```

这正是"原文学习 + 笔记学习"知识闭环的技术实现。

### 12.3 RelationGraph 扩展

- `KIND_COLORS` 新增 PDF 类型颜色
- `buildGraphData()` 已通用（`ann.kind || 'inline'` 自动兼容新 kind）
- `computeCurvature()` 纯图论算法，100% 复用

---

## 13. 实施路线图

### Phase 1: PDF 高亮 MVP (2-3 周)

**目标**: PDF 上文本高亮标注 + 关系系统复用

| 任务 | 文件 | 工作量 | 优先级 |
|------|------|--------|--------|
| 1. Annotation 接口扩展 (docType/pdfSelector) | `types/annotation.ts` | 1天 | P0 |
| 2. IndexLayer 新增 _byDocType/_byPage | `db/index-layer.ts` | 1天 | P0 |
| 3. QueryEngine docType/page 过滤 | `db/query-engine.ts` | 0.5天 | P0 |
| 4. PdfFormat 注册 + resolveFormat 扩展 | `format/format-registry.ts`, `format-interface.ts` | 0.5天 | P0 |
| 5. PDFViewerBridge 实现 | 新文件 `pdf-viewer-bridge.ts` | 2天 | P0 |
| 6. PDF 高亮 overlay 渲染 | 新文件 `pdf-highlight-overlay.ts` | 2天 | P0 |
| 7. PDF textLayer 交互 + selection 获取 | 新文件 `pdf-text-selection.ts` | 1天 | P0 |
| 8. PDF 标注创建流程 | `plugin/annotation-creator.ts` 扩展 | 1天 | P0 |
| 9. 侧边栏 docType 过滤 + PDF 预览 | `ui/sidebar/` 扩展 | 1天 | P1 |
| 10. W3C PDF Selector 序列化 | `export/w3c-serializer.ts` 扩展 | 0.5天 | P1 |
| 11. KIND_COLORS 扩展 | `ui/graph/graph-data-builder.ts` | 0.5天 | P1 |
| 12. 测试: PDF 标注 CRUD + 索引 + 关系 | 新文件 `tests/pdf-*.test.ts` | 2天 | P0 |

**总计**: ~12 天（含测试）

### Phase 2: 区域标注 + 预览 (1-2 周)

| 任务 | 工作量 | 优先级 |
|------|--------|--------|
| 矩形拖拽选择工具 | 2天 | P0 |
| 归一化坐标存储 + 缩放还原 | 1天 | P0 |
| 截图预览生成 (canvas.toDataURL) | 1天 | P1 |
| PDF 标注工具栏 UI | 1天 | P1 |
| 区域标注 W3C SvgSelector | 0.5天 | P1 |
| 测试 | 1天 | P0 |

**总计**: ~5.5 天

### Phase 3: 高级标注 + 跨文档关系 (2-3 周)

| 任务 | 工作量 | 优先级 |
|------|--------|--------|
| 自由画笔 (SVG path + Douglas-Peucker) | 3天 | P0 |
| 跨页区域标注 | 2天 | P2 |
| PDF↔MD 跨文档关系完整交互 | 2天 | P0 |
| W3C RangeSelector 导入导出 | 1天 | P1 |
| PDF 标注导出为 Markdown 笔记 | 2天 | P1 |
| 测试 | 2天 | P0 |

**总计**: ~10 天

### Phase 4: 生态整合 (3-4 周，可选)

| 任务 | 工作量 | 优先级 |
|------|--------|--------|
| PDF++ 链接格式互转 | 2天 | P2 |
| Annotator 插件格式兼容 | 2天 | P2 |
| Zotero PDF 标注导入 | 3天 | P2 |
| PDF 直注模式 (@cantoo/pdf-lib) | 3天 | P3 |
| OCR 支持 (扫描件 PDF) | 4天 | P3 |

---

## 14. 技术依赖与风险

### 14.1 技术依赖清单

| 依赖 | 用途 | 来源 | 风险等级 |
|------|------|------|---------|
| **PDF.js** (Obsidian 内置) | PDF 渲染 + textLayer + getTextContent | Obsidian 核心依赖 | **低** |
| **PDFViewerChild API** | 访问 PDF 视图状态/事件 | Obsidian 私有 API | **中** — 需关注版本更新 |
| **SVG overlay** | 标注渲染层 | 标准 Web 技术 | **低** |
| **canvas API** | 截图预览 | 标准 Web 技术 | **低** |
| **归一化坐标** | 位置存储 | 算法层 | **低** — 不依赖任何外部 |
| **Douglas-Peucker** (Phase 3) | 画笔路径压缩 | 算法层 | **低** |
| **@cantoo/pdf-lib** (Phase 4) | PDF 直注写入 | npm 包 | **中** — 实验性 |

### 14.2 主要风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Obsidian PDF API 版本不稳定 | PDFViewerChild 可能随 Obsidian 版本失效 | PDF++ 已验证可行路径；桥接层做抽象，API 变化只改桥接层 |
| PDF.js 版本升级导致 textLayer 结构变化 | selection 定位可能失效 | 双定位策略（selection + rects），互为后备；rects 归一化存储，与版本无关 |
| 大型 PDF (500+ 页) 性能 | 标注渲染可能卡顿 | 分页懒加载（仅渲染可见页 ±1），SVG 虚拟化 |
| 扫描件 PDF 无 textLayer | 无法创建文本高亮 | Phase 1 跳过扫描件；Phase 4 可选 OCR |
| PDF 文件移动/重命名 | 标注 filePath 断裂 | 与 MD 文件重命名逻辑一致（`renameAnnotationsForFile` 已实现） |

### 14.3 PDF++ 的经验借鉴

PDF++ (2300⭐) 已经证明了在 Obsidian 中实现 PDF 标注的技术可行性：

- 使用 `PDFViewerChild` 私有 API 访问 PDF.js — 已稳定运行 1 年+
- `page + selection(4int)` 定位模式 — 简洁有效
- 反向链接存储策略 — 不修改 PDF，完全非破坏性
- **但**: 大量私有 API 依赖，插件更新风险；无关系系统；无学习状态

MarkVault 的差异化在于：同样的技术路径 + 更好的数据模型（docType + pdfSelector + 25种关系 + Flags）

---

## 15. 与 MindFlow 的协同设计

### 15.1 docType 基础设施共享

PDF 扩展建好 docType + Selector 路由后，MindFlow 选框标注只需 **20% 额外工作量**即可接入完整标注系统：

```
PDF 扩展建立的 docType 基础设施:
├── Annotation.docType 字段 + IndexLayer._byDocType 索引
├── Selector 路由机制 (resolveFormat → PdfFormat/MdFormat/MindMapFormat)
├── W3C FragmentSelector/SvgSelector 序列化
└── AnnotationFilter.docType 过滤

MindFlow 复用:
├── docType='mindmap' — 新增第三极，零改动
├── mindmapSelector: {filePath, nodeId, type:'node'|'group', nodeIds?}
├── 选框标注 — 与 PDFArea 完全同构（nodeIds 列表 vs rect 坐标）
└── 方案B文本标注 — %%mv:i%% 锚点，独立渲染逻辑
```

### 15.2 跨文档关系链完整闭合

三极 docType 闭合后，跨文档关系链真正完整：

```
PDF定理 (docType='pdf')
  → elaborates → MD笔记 (docType='markdown')
  → visualizes → 导图节点 (docType='mindmap')
  → references → PDF另一处 (docType='pdf')
```

---

## 16. 开发前置 Checklist

### 16.1 开发启动前必须完成

- [ ] Annotation 接口扩展设计评审（docType + pdfSelector + previewImage）
- [ ] PDFViewerBridge API 稳定性验证（Obsidian 当前版本测试）
- [ ] 归一化坐标算法验证（viewport ↔ normalized ↔ PDF 空间转换）
- [ ] PDF.js textLayer selection 提取验证（startIdx/startOff 模式）
- [ ] PDF 标注分片存储格式验证（filePath="book.pdf" 自动映射）
- [ ] PDF 标注 CRUD 单元测试框架搭建
- [ ] 侧边栏 docType 过滤 UI mockup

### 16.2 开发启动前需确认的决策

| 决策项 | 选项 | 推荐 | 备注 |
|--------|------|------|------|
| PDF 标注 kind 命名 | `pdf-highlight` vs `highlight-pdf` | `pdf-highlight` | 前缀统一，与现有 kind 格式一致 |
| PDF 坐标存储格式 | viewport px vs PDF pt vs normalized 0-1 | **归一化 0-1** | 与缩放/版本解耦，最鲁棒 |
| PDF 标注预览 | 截图 base64 vs PDF.js 文本提取 vs 两者 | **两者** | 文本做搜索/关系，截图做视觉预览 |
| 文本定位主策略 | selection(4int) vs rects(normalized) | **双定位** | selection 精确文本定位 + rects 渲染覆盖 |
| selection 格式 | PDF++ 4int vs pdf-annotate.js rectangles | **4int + rectangles** | 4int 精确定位 + rectangles 渲染后备 |
| Phase 1 边界 | 仅文本高亮 vs 含区域标注 | **仅文本高亮** | MVP 最小范围 |
| PDF 标注交互入口 | 右键菜单 vs 工具栏 vs 两者 | **两者** | 右键菜单快捷 + 工具栏明确 |

### 16.3 schemaVersion 策略

- MD 标注: schemaVersion = 1（现有）
- PDF 标注: schemaVersion = 2（新增 docType/pdfSelector 字段）
- 混合标注文件: 以标注自身的 schemaVersion 为准
- 旧版数据迁移: migration.ts 补上 docType='markdown'（默认值）

---

## 17. 测试规划

### 17.1 单元测试清单（Phase 1）

| 测试类 | 覆盖范围 | 优先级 |
|--------|---------|--------|
| PDFAnnotation CRUD | 创建/读取/更新/删除 PDF 标注 | P0 |
| PDFSelector 序列化 | selection → rects → 归一化 → 还原 | P0 |
| IndexLayer docType/page | _byDocType/_byPage 索引维护 | P0 |
| QueryEngine docType | 按文档类型过滤查询 | P0 |
| W3C PDF Target | FragmentSelector + SvgSelector 序列化/反序列化 | P1 |
| 跨文档关系 | PDF↔MD 关系创建 + 跳转路由 | P0 |
| PdfFormat 注册 | resolveFormat 路由到 PdfFormat | P1 |
| 归一化坐标转换 | viewport → normalized → viewport 精度验证 | P0 |

### 17.2 集成测试清单（Phase 1）

| 测试场景 | 描述 | 优先级 |
|---------|------|--------|
| PDF 高亮创建 | 选文本 → 创建标注 → overlay 渲染 → Store 写入 | P0 |
| PDF 标注跳转 | 侧边栏点击 → PDF 跳转到页码位置 | P0 |
| PDF↔MD 关系 | PDF 定理 → elaborates → MD 笔记 → 双向跳转 | P0 |
| PDF 标注导出 | W3C JSON-LD 导出含 PDF FragmentSelector | P1 |
| PDF 标注导入 | W3C JSON-LD 导入重建 PDFSelector | P1 |
| 大型 PDF 性能 | 100+ 页 PDF 的标注渲染性能 | P2 |

---

## 附录 A: 关键参考项目数据

| 项目 | Stars | 标注类型 | 定位方式 | 存储方式 | 契合度 |
|------|-------|---------|---------|---------|--------|
| **PDF++** | 2,300 | 文本高亮 | page+selection(4int) | MD 反向链接 | ★★★★★ |
| **pdf-annotate.js** | 295 | 高亮/矩形/画笔 | page+rectangles[{x,y,w,h}] | JSON 内存 | ★★★★ |
| **Hypothesis** | 大型 | 高亮/便签 | W3C Selector 全套 | 数据库 | ★★★★★ |
| **react-pdf-highlighter** | 48 | 高亮/区域 | position+content | JSON | ★★★★ |

## 附录 B: PDF 坐标系完整对照

```
PDF 空间坐标系 (PDF specification):
  原点: 左下角 (0, 0)
  Y轴: 向上 ↑
  单位: pt (1/72 inch)
  页面尺寸: 通常 595×842 pt (A4) 或 612×792 pt (Letter)

Viewport 坐标系 (PDF.js 渲染):
  原点: 左上角 (0, 0)
  Y轴: 向下 ↓
  单位: px (受缩放影响)
  尺寸: = PDF尺寸 × scale

归一化坐标系 (MarkVault 存储):
  原点: 左下角 (0.0, 0.0)
  Y轴: 向上 ↑
  单位: 比例 (0.0-1.0)
  转换: normalized = pdfPoint / pageSize
  还原: pdfPoint = normalized × pageSize
  viewport还原: viewportPoint = pdfToViewport(pdfPoint)

转换链:
  viewport → PDF空间: viewport.convertToPDFPoint(x, y)
  PDF空间 → 归一化: normalizedX = pdfX / pageWidth; normalizedY = pdfY / pageHeight
  归一化 → PDF空间: pdfX = normalizedX × pageWidth; pdfY = normalizedY × pageHeight
  PDF空间 → viewport: viewport.convertToViewportPoint(pdfX, pdfY)
```

## 附录 C: 数据流全景

```
┌─ PDF 标注创建流 ─────────────────────────────────────────────┐
│                                                              │
│  用户选文本/拖矩形                                             │
│      ↓                                                       │
│  PDFViewerBridge.getSelection() / getDragRect()              │
│      ↓                                                       │
│  PDFSelector 构建 (page + selection + rects/areaRect)        │
│      ↓                                                       │
│  getTextContent() → annotation.text                          │
│      ↓                                                       │
│  AnnotationModal (color/note/motivation/flags)               │
│      ↓                                                       │
│  buildAnnotation() → Annotation 对象                         │
│      ↓                                                       │
│  finalizeAnnotation() → Store 写入 + 索引更新                 │
│      ↓                                                       │
│  PDF overlay 渲染 (SVG rect/path 高亮覆盖层)                  │
│      ↓                                                       │
│  侧边栏刷新 (PDF 标注列表 + docType='pdf' 标记)               │
│                                                              │
└─ PDF 标注消费流 ─────────────────────────────────────────────┘
│                                                              │
│  侧边栏点击标注                                               │
│      ↓                                                       │
│  QueryEngine → Annotation 对象                               │
│      ↓                                                       │
│  docType='pdf' → 跳转路由: open PDF + scrollToPosition       │
│      ↓                                                       │
│  PDF viewer loaded → overlay 渲染高亮                        │
│                                                              │
│  RelationGraph 显示 PDF 标注                                  │
│      ↓                                                       │
│  KIND_COLORS['pdf-highlight'] → 节点着色                     │
│      ↓                                                       │
│  点击节点 → 同上跳转路由                                      │
│                                                              │
│  W3C 导出                                                    │
│      ↓                                                       │
│  buildPDFTarget() → FragmentSelector + TextQuote/SvgSelector │
│      ↓                                                       │
│  JSON-LD 输出                                                │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```
