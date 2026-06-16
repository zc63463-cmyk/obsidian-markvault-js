# MarkVault-JS Memory

## 项目概况
- Obsidian 批注插件，4 种批注类型 (inline/block/span/region)
- W3C Web Annotation Data Model 兼容导入/导出
- Schema-First 关系系统 (30 内置类型 = 16 active + 14 passive + 自定义扩展)
- 倒排索引架构 (12 indexes)，分片 JSON 持久化
- 测试: 379/379 全绿，tsx 运行器

## 版本状态
- manifest.json / package.json / versions.json: 5.0.0 ✅
- feature level: v5.12 (语义化调色板 + 芯片分组排序 + BUG-8~11 修复 + SEMANTIC_GROUPS 共享 + renderRelations dot)
- Obsidian SDK: ^1.7.2 (已锁定)

## 2026-06-15 综合审计 + 修复
- P1-1 ✅: deserializeFlags 类型校验 (as any → Set 校验)
- P1-2 ✅: serializeCollection 完整分页 (first/last/next/prev)
- P1-3 ✅: W3C 导入 API (w3c-import.ts, 3 种 UUID 冲突策略)
- P2-5 ✅: 版本号同步 5.0.0
- P2-7 ✅: Obsidian SDK 锁定 ^1.7.2
- P2-6 ✅: W3C 命令注册 (全部导出/文件导出/文件导入)
- v5.1 ✅: 删除关联确认提示 + 关联详情面板 (点击🔗展开)
- 部署到 E:\Notes\数据库系统概论\.obsidian\plugins\markvault-js\

## v5.8~v5.11 图谱语义增强
- v5.8: 关系类型 9→16 active (elaborates/exemplifies/illustrates/causes/enables/precedes/part-of + 7 passive)
  - 六维覆盖: Taxonomic/Argumentative/Referential/Comparative/Causal/Temporal/Part-whole 全 100%
  - 修复 RELATION_PALETTE 旧错误 (supports→proves, contradicts→refutes, isContrastedBy 删除)
  - 修复 CSS chip 颜色 ID 不匹配
- v5.9: Relation+Kind 芯片分离到独立行
- v5.10: 被动关系灰色边 (#99a3b3) + chip 色块分离设计 (dot+label)
- v5.11: 语义化调色板 — 6 维度分层着色 + 芯片分组排序渲染
  - 每组: taxonomic(indigo/violet/deeppurple) / argumentative(green/red/amber) / expositive(warm amber) / referential(cyan/blue) / dynamic(teal/rose/sky) / structural(warmgray/emerald)
  - 芯片间 1px 竖线分隔 + 紧凑英文标题
  - PASSIVE_COLOR #99a3b3→#9CA3AF, DEFAULT_RELATION_COLOR #94a3b8→#78716C

## 待办 (Phase 4C)
- P2-1: main.ts 3581行需拆分 (lifecycle/commands/sync/cache/settings)
- P2-2: annotation-store.ts 2400行需拆分 (relation/flag/group/persistence)
- P2-3: window.confirm → Obsidian Modal
- P2-4/P2-8: 清理 debug 测试 + 简化 MOTIVATION_MAP
- P2: renderToolbar() 每次点击 chip 全量重建 DOM，可改为增量更新 class
- P2: 缺少 computeCurvature 同向多关系类型、bfsReachable、邻居深度筛选的测试

## 2026-06-16 Bug 修复
- BUG-8 ✅: RangeError: Field is not present in this state — CM6 view 竞态
  - requestRegionLayerRedraw() 增加 state?.field 有效性检查
  - onunload() 首行 setActiveEditorView(null)
- BUG-9 ✅: rebuildAdjacencyMap() link.source as string → typeof 检查 + .id
- BUG-10 ✅: refresh() 每次都 zoomToFit → shouldZoomToFit 参数化
- BUG-11 ✅: computeCurvature 同向多关系类型边重叠 + 双向边 reverse 负 curvature
- v5.12 ✅: RelationPickerModal 类型选择器 — 分组 dot+label 芯片

## 已知 P2 改进项
- renderToolbar() 每次点击 chip 全量重建 DOM，可改为增量更新 class
- window.confirm → Obsidian Modal
- 缺少 computeCurvature 同向多关系类型、bfsReachable、邻居深度筛选的测试
