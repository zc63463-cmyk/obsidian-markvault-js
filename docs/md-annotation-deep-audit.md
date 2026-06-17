# MD 标注系统深度审查 — 问题清单

> 审查日期: 2026-06-17 | 3路并行审查 | P0×8 P1×20 P2×12 = 40 项

---

## 一、P0 级问题（8项 — 数据准确性/核心功能受损）

### 定位与跳转

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| P0-1 | **forceSyncFile 恢复失败无通知无标记** — block/span/region 恢复失败时仅 `failed++`，不发送 Notice，不标记为孤儿 | sync-engine.ts:210-213 | 标注静默漂移，用户无感知 |
| P0-2 | **编辑模式跳转用 `vault.read()` 而非 `editor.getValue()`** — vault.read 可能返回缓存内容，与编辑器不同步 | AnnotationSidebar.ts:513 | 跳转到错误位置 |
| P0-3 | **span 锚点偏移修正遗漏 `[fromA, toA)` 区间** — 只有 `startOffset >= change.toA` 分支，缺少 `startOffset >= change.fromA` | offset-tracker.ts:157-159 | span 锚点偏移漂移 |
| P0-4 | **`findSpanLineBySignature` 单行指纹 vs 多行签名** — 对每行算 `computeSignature(line)` 与多行 `targetHash` 比较，永远不匹配 | block-fingerprint.ts:178-208 | span 指纹搜索永远失败 |
| P0-5 | **block 创建时 `contextBefore/contextAfter` 为空字符串** — 恢复只能走策略4（纯文本匹配），精度大幅下降 | context-menu.ts:751-752 | block 恢复精度低 |
| P0-6 | **region 的 startOffset/endOffset 语义与其他类型不一致** — region 包含锚点文本长度，inline 不包含，跨类型偏移计算必须分叉 | 全链路 | 维护复杂度/出错概率高 |
| P0-7 | **代码块内 inline 标注渲染异常** — `<mark>` 和 native 锚点在 CM6 代码块 Widget 内无法被 Decoration 正确覆盖；阅读模式下 `<mark>` 在 `<code>` 内被转义不渲染 | highlight-applier.ts + reading-processor.ts | 代码块内标注不可见 |
| P0-8 | **inline 标注重叠时编辑模式只显示第一个** — `filterOverlapping` 跳过重叠标注；阅读模式 DOM 天然支持嵌套 | highlight-applier.ts:862-885 | 编辑/阅读显示不一致 |

### 数据一致性

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| P0-9 | **`updateAnnotation` 不自动更新 `updatedAt`** — 所有辅助方法 (addTag/removeTag/updateFlags/addGroup/removeGroup) 也不更新。排序/统计/W3C导出modified字段全部错误 | annotation-store.ts:255-328 | 所有标注修改操作的时间戳错误 |

---

## 二、P1 级问题（20项 — 功能缺陷/用户体验受损）

### 定位与跳转

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| P1-1 | forceSyncFile 两次 DB 查询可能脏读 | sync-engine.ts:190 | 轻微数据不一致 |
| P1-2 | region 恢复不检查锚点成对完整性 | sync-engine.ts:327-358 | region 定位漂移 |
| P1-3 | 编辑模式跳转定位到锚点文本而非标注内容 | AnnotationSidebar.ts:525-530 | 跳转后看不到标注 |
| P1-4 | 阅读模式跳转失败后静默切换源码模式 | AnnotationSidebar.ts:478-484 | 用户困惑 |
| P1-5 | RelationGraph 跳转只打开文件不定位到标注位置 | RelationGraphView.ts:668-678 | 图谱跳转失效 |
| P1-6 | applyIncrementalOffsetFix 排序和遍历方向矛盾 | offset-tracker.ts:83 | 多变更偏移修正不准 |
| P1-7 | 偏移修正后不更新 contextBefore/contextAfter | offset-tracker.ts:247-256 | 后续全量恢复走降级路径 |
| P1-8 | 搜索窗口固定 30 行 | block-fingerprint.ts:9 | 大编辑量后恢复失败 |
| P1-9 | 阅读模式 inline 创建 `startLine=0` 硬编码 | annotation-creator.ts:200 | 跳转降级到行0 |
| P1-10 | span `startLine = anchorLine + 1` 0-based/1-based 歧义 | context-menu.ts:542 | 降级跳转偏差1行 |

### 数据一致性

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| P1-11 | block 双锚点格式 `%%markvault-block%%` 不含 alias 段 | annotation-parser.ts:508-543 | alias 在 Markdown round-trip 中丢失 |
| P1-12 | region 锚点格式 `%%markvault-region%%` 不含 alias 段 | region-annotation.ts:43-48 | alias 在 Markdown round-trip 中丢失 |
| P1-13 | `updateRegionAnnotation` 不支持 alias 字段更新 | region-annotation.ts:203-206 | region alias 修改无法同步到 MD |
| P1-14 | `AnnotationCreateParams` 不接受 `fields` 参数 | annotation-creator.ts:22-46 | 模板预填 fields 创建时丢失 |
| P1-15 | migration.ts 遗漏 v3.0+ 字段 (format/flags/groups/motivation/alias) | migration.ts:60-84 | 旧数据迁移丢失部分字段 |
| P1-16 | `updateAnnotation` 处理 filePath 变更时有异步竞态 | annotation-store.ts:284-316 | 极少触发但数据不一致风险 |

### 渲染一致性

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| P1-17 | 编辑模式点击标注无响应 (ignoreEvent=true) | highlight-applier.ts:282-284,372-374 | 编辑模式无法点击标注 |
| P1-18 | block 标注编辑模式无徽章/批注指示器 | highlight-applier.ts vs reading-processor.ts | 编辑/阅读视觉不一致 |
| P1-19 | region 标注编辑/阅读视觉差异显著 | highlight-applier.ts:679-708 vs reading-processor.ts | 编辑半透明背景 vs 阅读块级边框 |
| P1-20 | 多 region 重叠时 dataset.uuid 覆盖 | reading-processor.ts:832 | 只能点击最后一个 region |
| P1-21 | 大文件每次按键全量重建 Decoration | highlight-applier.ts:386-399 | 10000+行文件卡顿 |
| P1-22 | 同一文件双 leaf 编辑+阅读缓存竞态 | cache-manager.ts + highlight-applier.ts | 全局单例缓存互相干扰 |
| P1-23 | 表格内标注行号映射可能不准确 | reading-processor.ts:594-705 | MD表格行≠HTML行 |
| P1-24 | span 创建后首帧缓存未同步 | highlight-applier.ts:491-511 | 首帧高亮偏移闪烁 |

---

## 三、P2 级问题（12项 — 设计不完善/可优化）

| # | 问题 | 文件 | 说明 |
|---|------|------|------|
| P2-1 | djb2 32-bit hash 碰撞风险 | block-fingerprint.ts:17-30 | 大量相似块可能误定位 |
| P2-2 | 冷却期 30s 硬编码 | sync-engine.ts:85 | 不可配置 |
| P2-3 | 50% 重叠阈值硬编码 | offset-tracker.ts:129,204 | 短标注易误删 |
| P2-4 | 代码块指纹计算基准不一致 | block-fingerprint.ts:64-107 | 围栏行 vs 内部内容 |
| P2-5 | inline 标注无 targetHash | 全局 | 短文本/重复文本漂移恢复弱 |
| P2-6 | IndexLayer 不索引 alias / needsCorrection | index-layer.ts | 按 alias/纠错过滤只能全量扫描 |
| P2-7 | W3C 外部导入行号丢失 | w3c-serializer.ts:434-435 | 纯 W3C 格式无 startLine |
| P2-8 | hideLeakedAnchorText 可能误匹配 | reading-processor.ts:938-970 | 用户正文含 "markvault" 被隐藏 |
| P2-9 | 阅读模式 span 文本片段搜索含 MD 特殊字符 | reading-processor.ts:1593-1623 | `**` `*` 等已渲染移除 |
| P2-10 | 编辑模式无 tooltip | highlight-applier.ts | 阅读模式有 title，编辑模式没有 |
| P2-11 | region layer 覆盖范围含锚点区域 | highlight-applier.ts:1031 | 视觉覆盖偏大 |
| P2-12 | Mark 解析 schemaVersion 兜底1而非2 | annotation-parser.ts:73-93 | 语义不精确 |

---

## 四、推荐修复批次

### 第一批：P0 核心修复（预计 2 天）

| 序号 | 问题 | 修复方案 | 工时 |
|------|------|---------|------|
| 1 | P0-9 updatedAt 不更新 | `updateAnnotation` 开头自动 `changes.updatedAt = Date.now()`；所有辅助方法也加上 | 0.5h |
| 2 | P0-1 恢复失败无通知 | forceSyncFile 失败时 `new Notice('标注恢复失败: N个')` + 标记 `needsCorrection=true` | 1h |
| 3 | P0-2 跳转用 vault.read | 改用 `editor.getValue()` 或 CM6 `SearchCursor` | 1h |
| 4 | P0-3 span 偏移修正遗漏区间 | 补充 `else if (ann.startOffset >= change.fromA)` 分支 | 0.5h |
| 5 | P0-4 findSpanLine 单行vs多行 | 重写为从起始行向后累积文本算多行指纹 | 2h |
| 6 | P0-5 block context 为空 | 创建 block 时提取上下文信息（同 inline） | 1h |
| 7 | P0-7 代码块内inline | parseMarkTags 增加 `md-context` 代码块范围检测，跳过代码块内的标注 | 2h |
| 8 | P0-8 inline重叠 | filterOverlapping 增加降级：保留所有重叠标注，用不同透明度区分 | 2h |

### 第二批：P1 跳转+定位修复（预计 2 天）

| 序号 | 问题 | 修复方案 | 工时 |
|------|------|---------|------|
| 9 | P1-3 跳转到锚点而非内容 | block/span 跳转到 targetLine，inline 跳转到内容偏移 | 1h |
| 10 | P1-5 图谱跳转不定位 | 复用 AnnotationSidebar.jumpToAnnotation 完整逻辑 | 1h |
| 11 | P1-7 偏移修正不更新context | delta 超阈值时重新提取 contextBefore/contextAfter | 1h |
| 12 | P1-9 startLine=0 | 从 offset 计算正确行号 | 0.5h |
| 13 | P1-2 region 锚点成对检查 | parseRegionAnnotations 增加 start/end 配对验证 | 1h |
| 14 | P1-11/12 alias 丢失 | 扩展双锚点/region 格式增加 alias 段 | 3h |
| 15 | P1-14 CreateParams 缺 fields | 扩展 AnnotationCreateParams 增加 fields 参数 | 0.5h |
| 16 | P1-17 编辑模式点击 | ignoreEvent=false + click handler | 2h |

### 第三批：渲染一致性+P1收尾（预计 2 天）

| 序号 | 问题 | 修复方案 | 工时 |
|------|------|---------|------|
| 17 | P1-18 block编辑模式徽章 | 添加 Decoration.widget 徽章 | 1h |
| 18 | P1-19 region视觉统一 | 统一编辑/阅读 region 样式 | 2h |
| 19 | P1-21 大文件性能 | viewport 限制 + incremental cache update | 3h |
| 20 | P1-4 跳转失败通知 | 添加 Notice 说明降级原因 | 0.5h |
| 21 | P1-10 startLine 歧义 | 统一为 0-based，修复所有消费方 | 1h |

### 第四批：P2 清理 + 测试补齐（预计 3 天）

- P2 项逐个评估修复
- 补充测试：SyncEngine/OrphanDetector/AnnotationCreator/FormatRegistry/Migration/offset-tracker
- 目标：700+ 测试项

---

## 五、核心设计缺口（需专项设计）

1. **统一的偏移语义定义** — region 的 startOffset/endOffset 包含锚点 vs inline 不包含，缺少文档化和验证
2. **标注状态机** — 缺少 `status: active|drifted|orphan` 字段，恢复失败时无法标记
3. **span 指纹搜索的正确实现** — 当前设计是单行 vs 多行的根本缺陷，需重新设计
4. **跳转偏移校验** — 跳转后不验证是否确实在标注内容上
5. **增量恢复** — forceSyncFile 全量恢复，大文件应只恢复受影响范围
6. **djb2 → fnv1a/murmur3 升级** — 32-bit 碰撞风险，长期需升级
