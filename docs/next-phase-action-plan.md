# MarkVault-JS 后续行动建议

> 审查日期: 2026-06-17 | 版本: v5.0.0 (feature v5.15) | 测试: 539/539 全绿

---

## 一、系统完备度评估

| 维度 | 当前评分 | Phase 1 后 | 说明 |
|------|---------|-----------|------|
| 核心标注 | 9/10 | 9 | 4 类型 + 3 样式 + 5 色 + 双模式渲染，功能完整 |
| 认知数据 | 9/10 | 9 | 4 层模型 + 25 关系 + Flags，设计极其完整 |
| 代码结构 | 8/10 | 8.5 | main.ts 已拆至 697 行，但 ReadingProcessor 1731 行仍偏大 |
| 测试覆盖 | 6/10 | 7.5 | 539 项全绿但关键模块无独立测试（SyncEngine/Creator/Migration/Orphan） |
| W3C 兼容 | 8/10 | 9 | 导出/导入完整，FragmentSelector/SvgSelector 未扩展 |
| 文档完整 | 9/10 | 9 | 规划文档非常详尽（可行性+验证+实施+3轮审查） |
| 未来扩展 | 5/10 | 8 | docType 不存在是硬瓶颈，建好后 3 条产品线可铺开 |

**关键结论**: 核心标注系统已非常完备（9/10），最大的价值增长点不在功能完善，而在 **产品维度跃迁**（PDF → MindFlow → AI Agent）。瓶颈是 docType 统一路由。

---

## 二、Phase 0 — 技术债清偿（1 周内，7h 总工时）

> 低成本高收益，消除已知隐患，为后续扩展扫清障碍

| # | 项目 | 工时 | 风险 | 说明 |
|---|------|------|------|------|
| 0-1 | `window.confirm` → Obsidian Modal | 1h | 零 | 单点替换，改善 UX 一致性 |
| 0-2 | `renderToolbar()` 增量更新 | 2h | 低 | 当前每次点击 chip 全量重建 DOM，改为增量更新 class |
| 0-3 | 补充图谱/关系测试 | 3h | 低 | computeCurvature 同向多类型 + bfsReachable + 邻居深度筛选 |
| 0-4 | 清理 debug 测试 + 简化 MOTIVATION_MAP | 1h | 零 | 删除 debug-block-ranges.test.ts 调试残留 |

**产出**: 测试数量 → 560+，测试覆盖 6→7.5

---

## 三、Phase 1 — docType 基础设施（1-2 周）

> **所有后续扩展的枢纽点**，PDF 和 MindFlow 都依赖它

### 3.1 核心改动

| # | 改动 | 影响文件 | 说明 |
|---|------|---------|------|
| 1-1 | Annotation 接口增加 `docType: 'markdown' \| 'pdf' \| 'mindmap'` | `types/annotation.ts` | 默认值 `'markdown'`，向后兼容 |
| 1-2 | 增加 `pdfSelector?: PdfSelector` 字段 | `types/annotation.ts` | PdfSelector = { page, textSelection, rectangles, svgPath } |
| 1-3 | 增加 `mindmapSelector?: MindmapSelector` 字段 | `types/annotation.ts` | { filePath, nodeId, type, nodeIds? } |
| 1-4 | byDocType 索引 | `db/index-layer.ts` | `Map<docType, Set<uuid>>` 倒排索引 |
| 1-5 | byPage 索引（PDF） | `db/index-layer.ts` | `Map<filePath:page, Set<uuid>>` |
| 1-6 | byNodeId 索引（MindFlow） | `db/index-layer.ts` | `Map<nodeId, Set<uuid>>` |
| 1-7 | W3C FragmentSelector 扩展 | `db/w3c-serializer.ts` | PDF 文本高亮 → FragmentSelector |
| 1-8 | W3C SvgSelector 扩展 | `db/w3c-serializer.ts` | PDF 区域标注 → SvgSelector |
| 1-9 | docType 路由：SyncEngine 按类型分发 | `plugin/sync-engine.ts` | markdown 走现有逻辑，pdf/mindmap 各走专属路径 |
| 1-10 | OrphanDetector 按 docType 区分检测策略 | `db/orphan-detector.ts` | PDF 检查页面存在性，MindMap 检查节点存在性 |
| 1-11 | 数据迁移：旧数据补 `docType: 'markdown'` | `db/migration.ts` | 兼容无 docType 的旧数据 |
| 1-12 | Settings Tab 增加 docType 配置区 | `ui/settings/settings-tab.ts` | 启用/禁用 PDF/MindFlow 支持 |

### 3.2 设计约束

- **向后兼容**: 所有现有数据默认 `docType: 'markdown'`，迁移零破坏
- **优雅降级**: PDF/MindFlow 功能未安装时，docType 字段存在但不生效
- **W3C 兼容**: 新 Selector 类型符合 W3C Web Annotation Data Model 扩展规范
- **最小化改动**: 核心标注逻辑不变，仅增加路由层和索引层

### 3.3 依赖关系

```
Annotation.docType 字段 (1-1)
  ├──→ pdfSelector 字段 (1-2) ──→ W3C FragmentSelector (1-7)
  ├──→ mindmapSelector 字段 (1-3) ──→ W3C SvgSelector (1-8)
  ├──→ byDocType 索引 (1-4) ──→ byPage 索引 (1-5)
  │                          ──→ byNodeId 索引 (1-6)
  ├──→ SyncEngine docType 路由 (1-9)
  ├──→ OrphanDetector docType 策略 (1-10)
  ├──→ 迁移补 docType (1-11)
  └──→ Settings docType 配置 (1-12)
```

### 3.4 完成标准

- 560+ 测试全绿
- `docType: 'pdf'` 标注可创建/查询/序列化（不需 PDF 渲染层）
- W3C 导出正确包含 FragmentSelector/SvgSelector
- 旧数据自动迁移为 `docType: 'markdown'`
- 索引查询 `store.queryByDocType('pdf')` 可用

---

## 四、Phase 2A — PDF 标注 MVP（2-3 周）

> docType 基础设施就位后，PDF 扩展仅需在渲染层叠加

| # | 功能 | 说明 | 依赖 |
|---|------|------|------|
| 2A-1 | PDF.js viewer overlay | 在 Obsidian 的 PDF 视图上叠加标注层 | Phase 1 |
| 2A-2 | PDF 文本选择 → PDFHighlight | 选中 PDF 文本创建高亮标注 | 1-2, 1-7 |
| 2A-3 | PDF 跳转 | 点击标注跳转到 PDF 对应页面+位置 | 1-5 |
| 2A-4 | 标注侧边栏 PDF 分组 | 按 PDF 文件+页码分组显示 | 1-4, 1-5 |
| 2A-5 | 反向链接存储 | 标注数据不修改 PDF 文件本身 | 1-1 |

### Phase 2A+ (后续迭代)

| # | 功能 | 工期 |
|---|------|------|
| 2A-6 | PDFArea 矩形标注 + 截图预览 | 1-2 周 |
| 2A-7 | PDFInk 画笔标注 | 1 周 |
| 2A-8 | PDF↔MD 跨文档关系 | 1 周 |
| 2A-9 | PDF++ / Annotator / Zotero 兼容 | 3-4 周 |

---

## 五、Phase 2B — MindFlow 思维导图（2 周 + 标注接入 1.5 周）

> 独立插件，通过 Bridge API 与 MarkVault 互联

| # | 功能 | 说明 | 依赖 |
|---|------|------|------|
| 2B-1 | MD Parser + 树布局 + SVG 连线 | 从 Markdown 列表种子生成导图 | 无 |
| 2B-2 | 折叠展开 + 拖拽 | 基础交互 | 无 |
| 2B-3 | Frontmatter 读写 | 导图元数据持久化 | 无 |
| 2B-4 | MD 实时渲染 | 节点内 Markdown inline 渲染 | 无 |
| 2B-5 | MarkVault Bridge API | 读取 AnnotationStore + docType 路由 | Phase 1 |
| 2B-6 | 方案 B 文本标注 | `%%mv:i%%` + 粗体，颜色交由节点背景色 | Phase 1 |
| 2B-7 | 语义着色 + 学习状态可视化 | 认知数据层在导图中的视觉表现 | Phase 1 |

**关键**: Phase 1 docType 路由建好后，MindFlow 标注接入仅需 **20% 额外成本**。

---

## 六、Phase 3 — 认知系统 + AI Agent（4-6 月）

> 数据飞轮：标注积累 → AI 分析 → 服务增强 → 更多标注

| # | 功能 | 时间 | 说明 |
|---|------|------|------|
| 3-0 | 认知数据 Schema 文档化 | 1 周 | Phase 0 遗留，W3C JSON-LD Schema 公开文档 |
| 3-1 | AI Agent 原型 | 4-6 月 | 纠偏提醒 + 学习报告 + 间隔复习调度 |
| 3-2 | 认知服务上线 | 6-9 月 | 订阅制（¥15-30/月）+ 深度分析 + 表达辅助 |
| 3-3 | 认知范式升级 | 9-12 月 | 时态关系 + 认知状态机 + AI 关系推断 |

**商业模型** (PCV 20/24 Exceptional):
- 免费插件: 核心标注 + 基础关系
- AI Agent: ¥15-30/月，纠偏/复习/学习路径
- Pro: ¥50-100/月，深度分析 + 表达辅助

---

## 七、延后项（不推荐近期实施）

| 项目 | 原因 | 建议时机 |
|------|------|---------|
| C-1 哈希锚点 (hash-as-anchor) | 4 层恢复机制已够稳健，额外 ROI 有限 | Phase III+ |
| C-2 快照历史 (undo/diff UI) | UI 改动大、风险高 | Phase III-A |
| djb2 → xxHash 升级 | 32-bit 碰撞风险短期可控 | Phase 2A 大规模 PDF 标注后 |
| 搜索窗口动态调整 | +/-30 行固定窗口短期够用 | Phase 2A 后视反馈决定 |
| inline 标注 targetHash | 上下文文本恢复已够用，hash 注入破坏格式 | Phase III |

---

## 八、测试覆盖补齐计划

> 当前 539 项测试，目标 700+ 项

| 优先级 | 缺口模块 | 目标测试项 | 工时 |
|--------|---------|-----------|------|
| P1 | SyncEngine 锚点恢复 | 20+ | 3h |
| P1 | OrphanDetector 孤儿检测 | 15+ | 2h |
| P1 | AnnotationCreator 辅助函数 | 15+ | 2h |
| P1 | FormatRegistry / FormatSetup | 10+ | 2h |
| P2 | Migration 数据迁移 | 10+ | 2h |
| P2 | computeCurvature 同向多类型 | 8+ | 1h |
| P2 | bfsReachable + 邻居深度筛选 | 10+ | 2h |
| P2 | region-annotation targetHash | 5+ | 1h |
| P3 | ReadingProcessor (需 DOM mock) | 20+ | 4h |
| P3 | docType 路由 + 索引 (Phase 1) | 25+ | 4h |

---

## 九、关键风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| CM6 @codemirror/state 多实例 | 低(已修复) | 致命 | 必须用 `node esbuild.config.mjs production` |
| PDF.js 与 Obsidian PDF 视图冲突 | 中 | 高 | Phase 2A 先做 POC 验证 overlay 可行性 |
| MindFlow Bridge API 版本耦合 | 中 | 中 | Bridge API 接口版本化 + 优雅降级 |
| AI Agent 服务端延迟 | 中 | 中 | 本地 LLM 优先 (llama.cpp)，云端可选 |
| docType 字段迁移遗漏 | 低 | 中 | Phase 1 包含自动迁移 + 旧数据兼容 |

---

## 十、推荐执行顺序

```
Phase 0 (7h) → Phase 1 (1-2周) → Phase 2A (2-3周) 或 Phase 2B (2周) → Phase 3 (4-6月)
                    ↓
              Phase 2A/2B 可并行
```

**第一步建议**: 先做 Phase 0 技术债清偿（半天完成），然后进入 Phase 1 docType 基础设施设计。
