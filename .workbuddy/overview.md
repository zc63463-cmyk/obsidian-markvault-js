# v5.8 关系类型覆盖补全 — 实施总览

## 核心变更：内置关系类型 9 → 16 (active)

### 新增 7 种主动关系类型

| ID | 标签 | 语义维度 | 反向 ID | 颜色 |
|----|------|---------|---------|------|
| `elaborates` | 详述 | Expositive (阐释) | isElaboratedBy | #a78bfa |
| `exemplifies` | 举例 | Expositive | isExemplifiedBy | #fbbf24 |
| `illustrates` | 图示 | Expositive | isIllustratedBy | #fb923c |
| `causes` | 导致 | Causal (因果) | isCausedBy | #f43f5e |
| `enables` | 使能 | Causal | isEnabledBy | #14b8a6 |
| `precedes` | 先于 | Temporal (时序) | follows | #0ea5e9 |
| `part-of` | 部分 | Part-whole (组成) | contains | #8b5cf6 |

### 新增 7 种被动关系类型（系统自动维护）
isElaboratedBy, isExemplifiedBy, isIllustratedBy, isCausedBy, isEnabledBy, follows, contains

## 六维覆盖评估（补全前 → 后）

| 维度 | 补全前 | 补全后 |
|------|--------|--------|
| Taxonomic (分类) | 100% | 100% |
| Argumentative (论证) | 100% | 100% |
| Referential (引用) | 100% | 100% |
| Comparative (比较/阐释) | 67% | 100% |
| Causal (因果) | 0% | 100% |
| Temporal (时序) | 0% | 100% |
| Part-whole (组成) | 0% | 100% |

## 顺带修复的旧问题

1. **RELATION_PALETTE 错误条目**：`supports`(不存在)→删除, `contradicts`(不存在)→删除, `isContrastedBy`(不存在)→删除
2. **CSS chip 颜色 ID 不匹配**：旧 CSS 引用 `cite`/`support`/`refute`/`extend`/`relate`（全部不存在），替换为 16 种真实类型 ID
3. **W3C 序列化**：无需改动，`type: r.type` 直接字符串透传

## 变更文件清单

- `src/types/annotation.ts` — DEFAULT_RELATION_TYPE_CONFIGS: 13→30 条
- `src/ui/graph/graph-data-builder.ts` — RELATION_PALETTE 完整重写
- `styles.css` — chip 颜色 16 种映射
- `tests/metadata-extension.test.ts` — active types 断言 9→16

## 测试结果
- 全部通过：metadata 73/73, graph 17/17, search 119/119, store 17/17, w3c-serializer, w3c-import
- 已部署到 Obsidian vault
