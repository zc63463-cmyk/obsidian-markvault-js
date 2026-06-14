# MarkVault Region 标注功能交接文档

> 本文档用于交接给下一位继续开发/调试 Region 标注功能的 agent。  
> 当前版本：`3.0.0`（未提交）  
> 最近改动未提交到 git，工作区为 `E:/Development/MyAwesomeApp/markvault-js/`。

---

## 1. 功能目标

Region 标注用于覆盖**包含公式、代码、图片、跨块/跨列表项**的选区。核心设计：

- 用两个 Obsidian 注释锚点包围选区内容：
  ```markdown
  %%markvault-region:<uuid>:<type>:<color>:start:<escaped-note>%%
  ...内容（可含公式/代码/图片）...
  %%markvault-region:<uuid>:<type>:<color>:end:<escaped-note>%%
  ```
- 编辑模式：CM6 `layer` + `RectangleMarker.forRange` 在锚点之间绘制背景层。
- 阅读模式：post-processor 在 DOM 中定位锚点并加 class/包裹；当 `%%` 注释被 Obsidian 剥离时，退而使用 section 行范围做 fallback。

---

## 2. 当前完成状态

| 模块 | 状态 | 说明 |
|------|------|------|
| Region 核心逻辑 | ✅ | `build/parse/findRange/remove/update/strip` |
| 编辑模式创建 | ✅ | 右键菜单 `▭ Region`；自动 fallback（特殊内容/跨块） |
| 阅读模式创建 | ✅ | 浮动工具条 `▭ Region`；右键 `▭ Region`；自动 fallback |
| 编辑模式渲染 | ⚠️ | CM6 layer 已改为 `above: true`；缓存刷新已补；仍需验证稳定性 |
| 阅读模式精确渲染 | ⚠️ | comment 路径 + section fallback + 文本节点精确包裹；列表项场景已优化 |
| 块级标注新视觉 | ✅ | 右上角类型徽章 + hover 背景 |
| Region 徽章 | ✅ | 阅读模式右上角 `▭·` 徽章 + 批注 `📝` 指示器 |
| 单元测试 | ✅ | `tests/region-annotation.test.ts` 7/7 通过 |
| 构建/测试 | ✅ | `npm run build` + `npm test` 34 项全部通过 |

---

## 3. 关键文件清单

### 3.1 核心逻辑

- `src/core/region-annotation.ts`
  - `buildRegionAnchor`：生成 start/end 锚点字符串。
  - `REGION_ANCHOR_REGEX`：匹配 `%%markvault-region:...%%`。
  - `parseRegionAnnotations`：解析文件内所有 region，返回 `kind: 'region'` 的 Annotation。
  - `findRegionRange` / `removeRegionAnnotation` / `updateRegionAnnotation` / `stripRegionAnnotations`。

### 3.2 解析集成

- `src/core/annotation-parser.ts`
  - `parseAllAnnotationsFromMarkdown` 汇总 inline / block / span / native / region。

### 3.3 编辑模式渲染

- `src/core/highlight-applier.ts`
  - `regionLayerExtension`：CM6 `layer`，按 `regionCache` 绘制背景矩形。
  - `regionCache` 相关：`updateRegionCacheForFile` / `getRegionCacheForFile`。
  - Region 锚点隐藏逻辑（`REGION_ANCHOR_REGEX.exec(doc)` + `Decoration.replace`）。

### 3.4 阅读模式渲染

- `src/main.ts`
  - `processRegionAnnotations(el, ctx)`：post-processor 入口。
    - 方案 A：DOM comment 节点精确高亮。
    - 方案 B：`ctx.getSectionInfo(el)` + `parseRegionAnnotations` + `applyRegionStyleToSectionPrecise` fallback。
  - `applyRegionStyleToSection`：整 section 染色（fallback）。
  - `applyRegionStyleToSectionPrecise`：用源文本锚点边界 → plain 文本 → DOM 文本节点精确包裹。
  - `wrapTextRange`：按字符偏移包裹文本节点。
  - `styleRegionBlockAncestor`：给最近块级祖先加背景 + 徽章。
  - `addRegionBadge`：右上角 `▭·` 徽章。
  - `findBestTextOffset`：阅读模式选中文本 → 源文件偏移；已加片段匹配和标题/列表标记处理。
  - `createReadingAnnotation`：阅读模式创建标注，支持 `kind === 'region'` 强制走双锚点。

### 3.5 UI 入口

- `src/ui/reading/ReadingModeToolbar.ts`
  - 浮动工具条新增 `▭ Region` 类型按钮。
- `src/ui/reading/ReadingModeContextMenu.ts`
  - 右键菜单新增 `▭ Region` 项。
- `src/ui/editor/context-menu.ts`
  - 编辑右键菜单新增 `▭ Region` 项；`createRegionAnnotation` 后调用 `plugin.updateRegionCache`。

### 3.6 样式

- `styles.css`
  - `.markvault-region-layer-bg`：编辑模式 layer 背景色。
  - `.markvault-region` / `.markvault-region-${type}` / `.markvault-region-${color}`：阅读模式 region 样式。
  - `.markvault-block-type-badge` / `.markvault-block-note-indicator`：块级标注徽章。
  - `.markvault-region-type-badge` / `.markvault-region-note-indicator`：region 徽章。

---

## 4. 数据模型

```ts
interface Annotation {
  kind?: 'inline' | 'block' | 'span' | 'region';
  // region 复用以下字段：
  startOffset: number;   // start 锚点起始偏移
  endOffset: number;     // end 锚点结束偏移
  startLine: number;     // start 锚点所在行
  endLine?: number;      // end 锚点所在行（parseRegionAnnotations 已补充）
  targetHash?: string;   // 内容指纹
}
```

---

## 5. 已知问题（交接时需重点处理）

下述问题来自实际测试，已部分修复但未完全闭环：

### 5.1 编辑模式 region 偶尔不显示

- **已做**：`createRegionAnnotation` 后刷新 `updateRegionCache`；`active-leaf-change` 监听刷新缓存；layer 改为 `above: true`。
- **仍需验证**：
  - 创建后是否需要手动触发 CM6 view update（目前依赖 `update` 钩子监听 `docChanged`）。
  - `resolveFilePath()` 与 `getFilePathFromView()` 在 source/live-preview 模式下是否都能正确取到文件路径。
  - region 跨段落或包含 Widget（公式/代码）时，`RectangleMarker.forRange` 是否覆盖完整区域。

### 5.2 阅读模式 region 范围不准

- **已做**：section fallback + 文本节点精确包裹。
- **仍可能**：
  - 当 region 跨多个 section 时，中间 section 可能漏染色（因为每个 section 独立处理，且只处理包含锚点或与其行范围重叠的 section）。
  - 包含图片、公式块等不可纯文本映射的内容时，`applyRegionStyleToSectionPrecise` 可能回退到整 section 染色。
  - 标题/列表项的 `markdownToPlainWithMap` 已处理标记，但复杂嵌套（callout、quote 内列表）仍需测试。

### 5.3 “Annotate this block” 无渲染

- 用户反馈：在小区域内右键 `Annotate this block`，编辑/阅读模式均无渲染。
- **可能原因**：
  - `detectBlockAtLine` 未识别到块，或块类型判断导致 anchor 插入位置错误。
  - 块锚点被插入后，CM6 行装饰或阅读模式 post-processor 未命中目标元素。
  - 需要复现并查看控制台。

### 5.4 多 agent 修改导致的 UI/逻辑分叉

- 同一功能存在多条创建路径（编辑右键、阅读工具条、阅读右键、自动 fallback），且视觉表现（编辑 layer vs 阅读 class）不一致。
- 建议下一步统一为单一状态机/路由，并补齐自动化测试覆盖编辑/阅读两条路径。

---

## 6. 构建、测试、部署

```bash
# 构建
cd /e/Development/MyAwesomeApp/markvault-js
npm run build

# 测试
npm test

# 部署到 Obsidian 插件目录
cp main.js styles.css manifest.json \
  /e/Notes/数据库系统概论/.obsidian/plugins/markvault-js/
```

刷新 Obsidian：`Ctrl + R`。

---

## 7. 建议下一步

1. **稳定性验证**
   - 在真实笔记中覆盖以下场景手动测试：
     - 普通段落 region
     - 列表单项 region
     - 跨多个列表项 region
     - 含行内公式 `$...$` 的 region
     - 含代码块/图片/callout 的 region
     - 编辑/阅读模式来回切换
   - 打开控制台（`Ctrl+Shift+I`）检查是否有报错。

2. **补齐自动化测试**
   - `tests/region-annotation.test.ts` 只测了核心字符串操作。
   - 建议新增：
     - `markdownToPlainWithMap` 对标题/列表/公式的映射测试。
     - `findBestTextOffset` 对含特殊格式选区的定位测试。
     - 阅读模式 DOM processor 的 mock 测试。

3. **统一创建路径**
   - 将编辑/阅读的 region 创建收敛到一个 `createRegionAnnotation` 公共方法，避免两份 `updateRegionCache` 调用遗漏。

4. **锚点格式升级（可选）**
   - 当前 `%%...%%` 在阅读模式会被 Obsidian 完全剥离，导致必须靠 fallback 行范围匹配。
   - 可考虑迁移到 HTML 注释 `<!-- markvault-region:... -->`（DOM 会保留 comment 节点），但需评估编辑模式隐藏和向后兼容。

5. **块级标注调试**
   - 重点复现 `Annotate this block` 无渲染的问题，检查 `detectBlockAtLine`、anchor 插入位置、CM6 行装饰、阅读模式 post-processor 是否都命中。

---

## 8. 联系人/上下文

- 当前分支：`master`（region 改动未提交）
- 部署目标：`E:/Notes/数据库系统概论/.obsidian/plugins/markvault-js/`
- 相关历史上下文见本次会话前文：用户主要关注“region 双锚点标注在编辑/阅读模式的一致渲染”。
