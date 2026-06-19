# PDF 扩展交接规划文档

> **用途**：新对话开发者基于此文档 + 项目代码库，直接开始 PDF 扩展 Phase 1 开发。
> **前置状态**：S0-S3 + 关系系统审查 + 反向关系构建器重构全部完成。架构基线干净。
> **日期**：2026-06-18

---

## 一、项目现状速览

### 已就绪（无需重做）

| 组件 | 状态 | 位置 |
|------|------|------|
| `PDFSelector` / `PDFRect` 类型 | ✅ 已定义 | `src/types/annotation.ts:52-68` |
| `DocType = 'markdown' \| 'pdf' \| 'mindmap'` | ✅ 已定义 | `src/types/annotation.ts:29` |
| `Annotation.docType?` / `Annotation.selector?` 字段 | ✅ 已加 | `src/types/annotation.ts:137-145` |
| `getDocType()` / `getSelector()` 辅助函数 | ✅ 已实现 | `src/types/annotation.ts:161-190` |
| `AnnotationRenderer` 接口 + `RendererRegistry` | ✅ 已实现 | `src/core/renderer.ts` |
| `byDocType` 索引 + `getAnnotationsByDocType()` | ✅ 已实现 | `src/db/index-layer.ts` |
| `stripExtraFields` 白名单含 v6.0 字段 | ✅ 已补 | `src/db/strip-fields.ts` |
| W3C 序列化器含 v6.0 字段 | ✅ 已补 | `src/export/w3c-serializer.ts` |
| 关系引擎 / Flags / Motivation / Search | ✅ 零改动复用 | — |
| 统一 logger 模块 | ✅ 已实现 | `src/utils/logger.ts` |

### 验证基线

- `tsc -noEmit` → exit 0
- `npm test` → 18 文件 576 用例全绿
- `esbuild` → 零警告

---

## 二、PDFSelector 实际定义（以代码为准）

```typescript
// src/types/annotation.ts

/** PDF 文档定位器 — 基于页码 + 矩形区域 */
export interface PDFSelector extends BaseSelector {
  type: 'pdf';
  page: number;              // 页码（0-indexed）
  rects: PDFRect[];          // 高亮区域矩形（PDF 坐标系，左下为原点）
  textHash?: string;         // 文本内容指纹（可选，用于漂移恢复）
}

/** PDF 矩形区域 */
export interface PDFRect {
  x1: number;  // 左下角 x
  y1: number;  // 左下角 y
  x2: number;  // 右上角 x
  y2: number;  // 右上角 y
}
```

**与设计文档的差异**：设计文档写的是 `{x, y, width, height}` + `selection{startIdx...}`，实际代码用的是 **PDFRect[] 四点坐标**。开发者实现 textLayer 交互时需自行将 selection 转换为 PDFRect[]。

---

## 三、Phase 1 开发范围（MVP，2-3 周）

### 目标
PDF 文本高亮标注的完整 CRUD：选中文本 → 创建高亮 → 侧边栏显示 → 点击跳转 → 编辑/删除。

### 核心任务

| # | 任务 | 新增文件 / 改动文件 | 说明 |
|---|------|---------------------|------|
| 1 | **PDFViewerBridge** | `src/pdf/viewer-bridge.ts` (新建) | 访问 Obsidian `PDFViewerChild`，提取 textLayer selection → 转 `PDFRect[]`。**首要验证项**。 |
| 2 | **PDFRenderer** | `src/pdf/pdf-renderer.ts` (新建) | 实现 `AnnotationRenderer` 接口。mount: 在 PDF viewer 上叠加 SVG overlay 渲染高亮。update: 标注变更时增量更新。scrollToAnnotation: 翻页 + 滚动到高亮位置。 |
| 3 | **RendererRegistry 注册** | `src/main.ts` (改动) | 插件 onload 中 `rendererRegistry.register(new PDFRenderer(...))`。根据文件类型路由到对应 renderer。 |
| 4 | **PdfFormat 注册** | `src/pdf/pdf-format.ts` (新建) | 标注格式注册（PDF 无锚点写入 MD，数据只在 Store）。`FormatRegistry.register()`。 |
| 5 | **PDF 标注创建** | `src/pdf/pdf-creator.ts` (新建) | 选中文本 → 构建 `Annotation`（`docType='pdf'`, `selector=PDFSelector`）→ `addAnnotation()` → `PDFRenderer.update()`。 |
| 6 | **侧边栏 docType 适配** | `src/ui/sidebar/AnnotationSidebar.ts` (改动) | 当 `docType='pdf'` 时不显示 startOffset 相关信息，显示页码。 |
| 7 | **反向链接存储** | 无新增 | PDF 标注数据存入 `annotations/{b64(filePath)}.json` 分片，`filePath="book.pdf"` 自动映射。PersistLayer 零改动。 |
| 8 | **测试** | `tests/pdf-annotation.test.ts` (新建) | PDF 标注 CRUD + 索引正确性 + 关系系统复用验证。 |

### 不做（明确排除）

- 矩形区域标注（PDFArea）→ Phase 2
- 跨文档关系 → Phase 3
- PDF++/Zotero 互转 → Phase 4
- OCR → Phase 4
- `text` 字段自动提取 → 留空，用户自行截图→AI→MD→粘贴填入

---

## 四、关键技术决策

### 4.1 不修改 PDF 原文

PDF 标注数据**只存在 MarkVault Store**（分片 JSON），不在 PDF 文件中写入任何内容。这与 Markdown 标注的"双写"模式不同——Markdown 标注需要锚点写入 .md 文件，PDF 标注完全外部存储。

**好处**：PDF 文件保持干净、支持任何 PDF 来源（包括加密 PDF）、标注可随时删除不影响原文。

### 4.2 坐标系统

PDF.js 使用**左下角为原点**的坐标系（y 轴向上）。`PDFRect` 的 `x1/y1` 是左下角，`x2/y2` 是右上角。在渲染 overlay 时需要转换为屏幕坐标系（左上角为原点，y 轴向下）。

### 4.3 text 字段留空

`Annotation.text` 字段对 PDF 标注默认留空。用户如需文本内容，自行截图→AI→MD→粘贴填入。这与设计文档 v1.2 校准一致。

### 4.4 Obsidian PDFViewerChild API

Obsidian 的 PDF 查看器基于 PDF.js，`PDFViewerChild` 是内部类。访问方式：
- 通过 `app.workspace.getActiveViewOfType()` 判断当前是否 PDF 视图
- PDF 视图的 `viewer` 属性可访问 PDF.js viewer 实例
- textLayer 的 selection 可通过 `window.getSelection()` 或 PDF.js `page.getTextContent()` 获取

**风险**：`PDFViewerChild` 是私有 API，可能随 Obsidian 版本变化。建议在 `viewer-bridge.ts` 中做防御性检查 + 版本探测。

---

## 五、数据流

```
用户在 PDF 中选中文本
  → PDFViewerBridge.getSelection() → PDFRect[] + page
  → PDFCreator.createAnnotation(rects, page)
    → buildAnnotation({ docType:'pdf', selector: PDFSelector, ... })
    → annotationStore.addAnnotation(ann)
    → PDFRenderer.update([ann])
      → SVG overlay 渲染高亮矩形
  → 侧边栏刷新（复用现有 refreshSidebar）
```

---

## 六、已有代码参考

| 模块 | 作用 | 参考 |
|------|------|------|
| `src/core/annotation-creator.ts` | `buildAnnotation()` / `finalizeAnnotation()` | PDF 创建标注时复用 |
| `src/db/annotation-repo.ts` | `addAnnotation()` / `getAnnotationsForFile()` | 直接调用，零改动 |
| `src/db/index-layer.ts` | `getAnnotationsByDocType('pdf')` | 查询所有 PDF 标注 |
| `src/core/renderer.ts` | `AnnotationRenderer` 接口 | PDFRenderer 实现此接口 |
| `src/ui/sidebar/AnnotationSidebar.ts` | 标注列表渲染 | 适配 docType='pdf' 的显示 |
| `src/utils/logger.ts` | 统一日志 | 用 `logger.debug()` 替代 console.log |

---

## 七、测试要求

### 新建 `tests/pdf-annotation.test.ts`

```
✅ PDF 标注 add → byUuid / byFile / byDocType 索引正确
✅ PDF 标注 update → 索引同步更新
✅ PDF 标注 delete → 索引清理 + 关系级联
✅ PDF 标注 + Markdown 标注共存于同一文件路径（不同 docType）
✅ PDF 标注创建关系 → 复用关系引擎，反向关系自动创建
✅ PDF 标注 selector 字段持久化 → stripExtraFields 不丢失
✅ PDF 标注 W3C 序列化往返无损
✅ getAnnotationsForFile 对 PDF 标注按 createdAt 排序
```

---

## 八、验证清单

开发完成后验证：
- [ ] `tsc -noEmit` → exit 0
- [ ] `npm test` → 全部通过（含新增 PDF 测试）
- [ ] `esbuild` → 零警告
- [ ] 在真实 PDF 上选中文本 → 高亮出现
- [ ] 切换页面 → 高亮消失/出现正确
- [ ] 关闭重开 PDF → 高亮恢复
- [ ] 侧边栏显示 PDF 标注
- [ ] PDF 标注可添加关系/标签/Flags
- [ ] 删除 PDF 标注 → 关系级联清理

---

## 九、参考文档

- 完整规划：`docs/specs/2026-06-17-pdf-extension-dev-planning.md`（17 章）
- 可行性分析：`docs/pdf-extension-feasibility.md`
- Obsidian Vault：`E:\Notes\DevNotes\Markvault-js开发\PDF扩展\`

---

## 十、约定

- 用 `logger.debug()` 替代 `console.log()`
- 新增字段到 `Annotation` 接口时，**必须同步更新三处**：`strip-fields.ts` 白名单 + W3C 序列化器 + 索引层
- 关系创建走 `buildReverseRelation()` 统一构建器，禁止手动 push 反向关系
- 测试用 `tsx` 运行器，与现有 18 个测试文件一致
- `npm test` 已包含全部 18 个测试文件，新增测试需补入 package.json
