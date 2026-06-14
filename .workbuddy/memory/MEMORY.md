# MarkVault-JS 项目记忆

## 项目概况
- **产品**: MarkVault-JS Obsidian 标注插件
- **版本**: 3.0.0
- **技术栈**: TypeScript + Obsidian API + CM6 Decoration + esbuild
- **核心功能**: 行内/块级/Span/Region 四种标注，编辑/阅读双模式渲染
- **作者**: Jiang（蒋指导）

## 关键架构
- `src/main.ts` — 插件入口（~2100行），含阅读模式 region 全套渲染逻辑
- `src/core/region-annotation.ts` — Region 锚点构建/解析/移除/更新
- `src/core/highlight-applier.ts` — CM6 Decoration + Region Layer 渲染
- `src/core/native-annotation.ts` — 行内标注（bold/highlight/underline）
- `src/db/annotation-store.ts` — 分片存储引擎（每文件一个 shard JSON）
- `src/ui/editor/context-menu.ts` — 编辑模式右键菜单入口
- `src/ui/reading/ReadingModeToolbar.ts` — 阅读模式工具条

## 测试运行方式
- `npm test` = `npx tsx tests/annotation-store.test.ts && npx tsx tests/native-annotation.test.ts && npx tsx tests/region-annotation.test.ts`
- 3 个测试文件共 34 项，全部为独立脚本（非 vitest）
- vitest 配置曾存在但实际不匹配，不要用 vitest 运行

## 已修复的关键 Bug

### Bug #5.1: 编辑模式 region 偶尔不显示
- **根因**: `editor.replaceSelection()` 同步触发 CM6 `docChanged` → layer `markers()` 读取空缓存 → 后续异步 `updateRegionCache()` 填充缓存后无重绘触发
- **修复**:
  1. 添加 `regionCacheUpdatedEffect` StateEffect + `requestRegionLayerRedraw()` 函数（highlight-applier.ts）
  2. 在 `updateRegionCache()` 末尾调用 `requestRegionLayerRedraw()`
  3. 添加 `updateRegionCacheImmediately()` 预填充方法，在 `replaceSelection` 前同步写入缓存
  4. 在 `active-leaf-change` 和 `onFileOpen` 中注入 `activeEditorView` 引用

### Bug #5.2: 阅读模式 region 范围不准
- **根因**: Obsidian post-processor 每 section 调用一次，跨 section 的 region start/end Comment 在不同 `el` 中，`TreeWalker` 只在单个 `el` 内搜索
- **修复**: 重写 `processRegionAnnotations`，支持 5 种场景：
  - A. 同 section 内有 start+end → 精确高亮
  - B. 只有 start（跨 section）→ 高亮到 section 末尾
  - C. 只有 end（跨 section）→ 高亮 section 开头到 end
  - D. section 完全在 region 内 → 高亮整个 section
  - E. Comment 被剥离 → fallback 用行范围匹配
- 新增 6 个辅助方法：`highlightRegionFromStart`, `highlightRegionToEnd`, `applyRegionStyleToNodes`, `applyRegionStyleFromStartAnchor`, `applyRegionStyleToEndAnchor`, `applyRegionStyleToMiddleSection`

### Bug #5.3: "Annotate this block" 无渲染
- **根因**（编辑模式）：与 #5.1 相同的异步缓存竞态 — `editor.replaceRange()` 触发 CM6 docChanged → decoration plugin 读取空 block 缓存 → 行装饰不渲染；且 `createBlockAnnotation` 创建后未调用 `updateSpanCache` 刷新缓存
- **根因**（阅读模式）：阅读模式创建 block annotation 后也未调用 `updateSpanCache`/`updateRegionCache`，导致切回编辑模式时缓存为空
- **修复**:
  1. 添加 `updateBlockCacheImmediately()` 预填充方法（main.ts），在 `replaceRange` 前同步写入 block 缓存
  2. `createBlockAnnotation`（context-menu.ts）在 `addAnnotation` 后增加 `updateSpanCache` + `updateRegionCache` 调用
  3. 阅读模式创建 block 后（main.ts ~line 2158）增加 `updateSpanCache` + `updateRegionCache` 调用
  4. `MarkVaultDecorator.update()` 增加 `regionCacheUpdatedEffect` 监听（与 region layer 修复一致的方案）
  5. `updateBlockCacheImmediately` 和 `updateRegionCacheImmediately` 预填充后均调用 `requestRegionLayerRedraw()`

## 通用修复模式：CM6 异步缓存竞态
所有创建标注的路径（inline/block/span/region）都有相同的竞态问题：
- **同步操作**（replaceSelection/replaceRange）→ 立即触发 CM6 重绘 → 缓存未更新 → 装饰缺失
- **修复方案**：在同步操作前预填充缓存 + 操作后刷新缓存 + `requestRegionLayerRedraw()` 强制 CM6 重绘

## 待处理事项
- #5.4 多 agent 导致的 UI/逻辑分叉 — 建议统一创建路径
- 锚点格式升级（可选）: `%%...%%` → HTML comment `<!-- ... -->`
- 补齐自动化测试: markdownToPlainWithMap / findBestTextOffset / DOM processor mock

## 部署路径
- 开发目录: `E:\Development\MyAwesomeApp\markvault-js`
- 部署目标: `E:\Notes\数据库系统概论\.obsidian\plugins\markvault-js\`
- 部署文件: main.js + manifest.json + styles.css（cp 覆盖即可）
