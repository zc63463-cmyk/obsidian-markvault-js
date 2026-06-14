# MarkVault-JS 项目记忆

## 项目概况
- **产品**: MarkVault-JS Obsidian 标注插件
- **版本**: 4.0.0 (Phase 4 implemented)
- **技术栈**: TypeScript + Obsidian API + CM6 Decoration + esbuild
- **核心功能**: 行内/块级/Span/Region 四种标注，编辑/阅读双模式渲染
- **作者**: Jiang（蒋指导）

## 关键架构
- `src/main.ts` — 插件入口（~2100行），含阅读模式 region 全套渲染逻辑
- `src/core/region-annotation.ts` — Region 锚点构建/解析/移除/更新
- `src/core/highlight-applier.ts` — CM6 Decoration + Region Layer 渲染
- `src/core/native-annotation.ts` — 行内标注（bold/highlight/underline）
- `src/db/annotation-store.ts` — 分片存储引擎（每文件一个 shard JSON）
- `src/search/filter-engine.ts` — 统一过滤引擎（applyUnifiedFilter + hasActiveFilters），所有过滤逻辑唯一实现
- `src/search/tokenizer.ts` — CJK bigram + 英文分词 + UUID 前缀分词器
- `src/search/search-engine.ts` — AnnotationSearchEngine（内存倒排索引 + 评分排序）
- `src/ui/editor/relation-picker-modal.ts` — Relation 选择器 Modal（搜索型，替代 prompt UUID）
- `src/ui/editor/context-menu.ts` — 编辑模式右键菜单入口
- `src/ui/reading/ReadingModeToolbar.ts` — 阅读模式工具条

## 测试运行方式
- `npm test` = 全量 6 个测试文件（Windows 需直接 `npx tsx tests/xxx.test.ts`）
- 6 个测试文件共 182 项（17 store + 10 native + 7 region + 9 block + 20 metadata + 119 search），全部为独立脚本（非 vitest）
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

## 数据持久化架构

### 存储引擎：AnnotationStore
- **磁盘**：分片 JSON（`.obsidian/plugins/markvault-js/annotations/{base64(filePath)}.json`），每文件一个 shard
- **内存**：12 个倒排索引 Map — `_byUuid` / `_byFile` / `_byKind` / `_byType` / `_byColor` / `_byTag` / `_byField` / `_byRelationOut` / `_byRelationIn` / `_byGroup` / `_byMastery` / `_byReviewPriority`
- **写入**：2s 防抖 per-file → `_scheduleFlush()` → `_writeFileShard()`；`shutdown()` → `flushAll()`
- **路径编码**：`FileEncoder.encodeFilePath` → Base64URL（UTF-8 → binary → base64 → URL-safe），完美支持中文路径

### 并发保护
- `ModifyGuard` — per-file 互斥锁（800ms 自动释放），防 sync 重入
- `_activeAnnotationUuids` — Modal 编辑中标注保护
- `_syncCooldown` — 30s 文件冷却
- `_isApplyingModify` — vault.modify 防重入

### 数据恢复路径
1. MD 完好 + 分片丢失 → `syncFromMarkdown()` 重建 DB
2. 分片完好 + MD 损坏 → `initialize()` 预加载恢复
3. 完全损坏 → `rebuildIndex()` 扫描 annotations/ 目录重建

## 导出系统现状
- **Settings 页**：`exportAnnotations()` → 全量 JSON
- **BatchBar**：过滤结果 / 选中标注 → JSON 或 Markdown
- **Markdown 格式**：按文件分组，含 text + note + fields + tags
- **缺失能力**：单文件限定、含上下文导出、CSV 格式、模板化导出
- **底层 API 已完备**：`queryAnnotations(filter)` + `getAnnotationsForFile(filePath)` + `getFieldKeys/Values`
- **扩展方向**：`ExportEngine` 模块 + `ExportRequest { source, filePath, filter, format, mode, groupBy }` 接口

## Phase 4-7 开发规划（2026-06-14 确认）

### Phase 4 — 知识元数据层 ✅ 已实现
- **Relation**：8 种语义关联，Store 双向索引（_byRelationOut + _byRelationIn），仅存 Store 不写 MD
  - API: addRelation/removeRelation/getRelations
  - 入边索引格式: `_byRelationIn: Map<targetUuid, Set<sourceUuid:relationType>>`
  - UI: RelationPickerModal（搜索型标注选择器，替代原始 prompt UUID）
- **Flag**：mastery(unknown/learning/familiar/mastered) + reviewPriority(low/medium/high/urgent) + confidence(1-5) + needsCorrection + lastReviewedAt + reviewCount，仅存 Store
  - API: updateFlags（合并更新）
- **Group**：多对多自由分组标签（groups: string[]），仅存 Store
  - API: addGroupToAnnotation/removeGroupFromAnnotation/getGroupNames
- **AnnotationFilter 扩展**：mastery/reviewPriority/hasRelations/group/needsCorrection
- **AnnotationStats 扩展**：withRelations/withGroups/withFlags/byMastery/byReviewPriority/needsCorrection
- **UI**：Modal 新增 Flags/Groups/Relations 编辑区；Card 新增元数据徽章；FilterBar 新增第四行过滤

### Phase 4.5 — 搜索系统重构 ✅ 已实现
- **统一过滤引擎**：`filter-engine.ts` — applyUnifiedFilter + hasActiveFilters，消除 Store/Sidebar 双轨过滤
- **CJK 分词器**：`tokenizer.ts` — bigram + 单字 + 英文 + UUID 前缀，去重输出
- **搜索引擎**：`search-engine.ts` — 内存倒排索引，search/suggest/rebuildIndex
- **搜索语义**：bigram OR + other OR（至少一个 bigram 命中 + 任一 other 命中）
- **评分模型**：BM25（默认）— IDF + TF saturation(k1=1.5) + 长度归一化(b=0.75) + 字段 multiplier；加权模型（suggest 使用）
- **模糊搜索**：Levenshtein 编辑距离（仅英文 token、长度≥3、首字符+长度剪枝、分数×0.85 折扣）
- **前缀搜索**：prefix 选项对未命中 token 做 startsWith 扩展（分数×0.9 折扣，上限 20）
- **索引持久化**：exportIndex/importIndex 往返 + main.ts onload/unload 集成（search-index.json）
- **共享 isCJK()**：tokenizer.ts 导出，filter-engine 和 search-engine 统一导入，覆盖 Extension A/B/C
- **RelationPicker**：搜索型标注选择器，selectedType 默认 null，Link 按钮需同时选中标注和关系类型才启用
- **Store.getAnnotationCount()**：O(1) 返回 _byUuid.size，供 SearchEngine 索引一致性检测
- **测试**：96 项搜索测试（含 BM25 5项 + Fuzzy 9项）+ 63 项存量 = 159 项全通过

### Phase 5 — LLM-ready 导出系统（2 周）
- **ExportEngine**：独立模块，配置驱动，不依赖具体数据模型
- **4 种格式**：JSON Schema / Markdown / CSV / LLM Prompt
- **Export Bundle**：一键三文件（annotations.json + knowledge-cards.md + llm-analysis-prompt.txt）
- **Prompt 模板**：4 个预设（掌握度评估/闪卡生成/隐含关联发现/理解纠偏）+ 用户自定义
- **MarkVault Data Protocol v1.0**：正式 JSON Schema，门户/外部工具可直接对接

### Phase 6 — 知识可视化与闭环（2-3 周）
- D3.js force-graph 图谱、动态摘要视图、AI 结果回注、统计面板增强

### Phase 7 — 独立门户（远期）
- 纯前端 SPA，读取 annotations/ 目录，学习仪表盘 + 知识图谱 + 智能搜索

### PCV 评估
- **20/24 Exceptional — Build NOW**
- Problem Score: 4/4（Frequency=Daily, Severity=Critical, Awareness=Actively Seeking, Budget=Would Find）
- Current Pain: 10/12, Your Improvement: 10/12
- 核心壁垒：Quality + Performance 两个维度无可替代
- #5.4 多 agent 导致的 UI/逻辑分叉 — 建议统一创建路径
- 锚点格式升级（可选）: `%%...%%` → HTML comment `<!-- ... -->`
- 补齐自动化测试: markdownToPlainWithMap / findBestTextOffset / DOM processor mock

## 部署路径
- 开发目录: `E:\Development\MyAwesomeApp\markvault-js`
- 部署目标: `E:\Notes\数据库系统概论\.obsidian\plugins\markvault-js\`
- 部署文件: main.js + manifest.json + styles.css（cp 覆盖即可）
