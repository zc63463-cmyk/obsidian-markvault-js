# MarkVault 标签系统深度规划 v2 — tags × fields 统一架构

> **日期**：2026-06-20 | **版本**：v2.0 | **前置文档**：[v1.0 调研报告](./2026-06-20-tag-system-advanced-design.md)
>
> **核心问题**：项目中有 `tags`、`fields`、`groups` 三套类元数据系统，职责边界模糊、功能重叠。本文档深度分析三者关系，提出统一架构方案。

---

## 1. 现状审计：MarkVault 元数据全景

### 1.1 标注上的全部元数据字段

| 字段 | 类型 | 值域 | 当前角色 | 示例 |
|------|------|------|---------|------|
| `tags` | `string[]` | 自由文本 | 主题标签 | `["数据库", "范式"]` |
| `fields` | `Record<string,string>` | key-value | 自定义属性 | `{ "u:difficulty": "进阶", "u:source": "课本" }` |
| `groups` | `string[]` | 自由文本 | 分组归类 | `["ch12", "exam_topics"]` |
| `flags` | `AnnotationFlag` | 枚举结构 | 学习状态 | `{ mastery: "mastered", confidence: 4 }` |
| `motivation` | `enum` | 5 种 | 标注意图 | `"questioning"` |
| `type` | `enum` | 3 种 | 视觉类型 | `"highlight"` |
| `color` | `enum` | 6 种 | 视觉颜色 | `"yellow"` |
| `alias` | `string` | 自由文本 | 图谱别名 | `"欧拉公式"` |

### 1.2 三者的功能重叠矩阵

| 能力 | `tags` | `fields` | `groups` |
|------|:--:|:--:|:--:|
| 多值 | ✅ `string[]` | ❌ 单值 per key | ✅ `string[]` |
| 结构化 key | ❌ 无 key | ✅ key-value | ❌ 无 key |
| 可搜索 | ✅ 搜索引擎索引 | ✅ 搜索引擎索引 | ✅ 搜索引擎索引 |
| 可筛选 | ✅ FilterBar `#` | ✅ FilterBar `🏷️` | ✅ FilterBar `Group` |
| 层级支持 | ❌ | ❌ | ❌ |
| 频率统计 | ✅ `getTagFrequencies` | ✅ `getFieldValues` | ✅ `getGroupNames` |
| 命名空间 | ❌ | ✅ `u:` 前缀 | ❌ |
| 模板预设 | ✅ `AnnotationTemplate.tags` | ✅ `AnnotationTemplate.fields` | ❌ |

### 1.3 核心矛盾

> **`tags` 和 `groups` 在功能上几乎完全等价** —— 两者都是 `string[]`，都支持搜索和筛选，都用于归类。唯一的区别是 `groups` 有"分组"的语义暗示，但在数据模型和筛选逻辑上完全相同。

> **`fields` 本质上就是「有 key 的 tags」** —— 当 tag 带上 key 就变成了 field，当 field 的 key 丢失就退化成 tag。两者在搜索引擎中被同等索引，在 FilterBar 中是两个独立的筛选入口。

**实际用户困惑场景**：
- 用户想标记"难度：进阶"——应该用 `tags: ["进阶"]` 还是 `fields: { "u:difficulty": "进阶" }`？
- 用户想标记"第三章"——应该用 `tags: ["ch3"]` 还是 `groups: ["ch3"]`？
- 用户想筛选"所有数据库相关的标注"——要在 `#` 标签筛 和 `🏷️` 字段筛 之间切换

---

## 2. 业界模型：元数据层次结构

基于 NNGroup 分类体系理论，知识管理系统的元数据呈现清晰的层次进化关系：

```
元数据 (Metadata) — 最广义概念
  │
  ├── 自由标签 (Free Tags) — 无受控，无结构
  │     └── MarkVault: tags, groups
  │
  ├── 受控词表 (Controlled Vocabulary) — 预定义术语集合
  │     └── MarkVault: motivation (5种), mastery (4种), type (3种)
  │
  ├── 分面分类 (Faceted Classification) — 多维正交，每维独立
  │     └── MarkVault: fields (key-value) ≈ 轻量分面
  │
  ├── 叙词表 (Thesaurus) — 受控 + 同义词 + 关联词
  │     └── MarkVault: u: 前缀约定 (部分实现)
  │
  └── 本体 (Ontology) — 多种语义关系
        └── MarkVault: relations (27种关系类型)
```

**关键洞察**：MarkVault 已经拥有了从自由标签到本体的全部层次，但它们分散在不同字段中，缺乏统一的协调层。

---

## 3. 统一架构方案：Unified Metadata Layer

### 3.1 设计原则

1. **不改存储模型** —— `tags`、`fields`、`groups` 保持原有数据结构，向后兼容
2. **统一认知模型** —— 在 UI 层和筛选层提供一致的交互范式
3. **渐进式升级** —— 用户可以继续用 tags，也可以升级到分面 fields，两者并行
4. **消除 groups** —— `groups` 在功能上是 tags 的子集，长期归并为 tags 的命名空间

### 3.2 认知模型重定义

```
┌─────────────────────────────────────────────────┐
│              认知元数据 (Cognitive)               │
│  flags: { mastery, confidence, reviewPriority,  │
│           needsCorrection, lastReviewedAt }     │
│  motivation: questioning | commenting | ...     │
├─────────────────────────────────────────────────┤
│              结构化分面 (Faceted)                 │
│  fields: {                                      │
│    "u:difficulty": "进阶",                       │
│    "u:source": "课本",                           │
│    "u:chapter": "第三章",                         │
│  }                                              │
├─────────────────────────────────────────────────┤
│              主题标签 (Thematic)                  │
│  tags: [                                        │
│    "数据库/范式/BCNF",    ← 层级标签               │
│    "topic:事务",          ← 分面前缀(可选)         │
│    "重要",                ← 自由标签               │
│  ]                                              │
├─────────────────────────────────────────────────┤
│              视觉属性 (Visual)                    │
│  type: highlight | bold | underline             │
│  color: yellow | green | blue | ...             │
│  alias: "欧拉公式"                               │
└─────────────────────────────────────────────────┘
```

### 3.3 三层职责重定义

| 层 | 字段 | 职责 | 特征 |
|---|------|------|------|
| **认知层** | `flags` + `motivation` | 标注者的认知状态和意图 | 枚举受控，系统语义 |
| **分面层** | `fields` | 结构化的属性维度 (key→value) | 每个维度独立筛选，AND 组合 |
| **主题层** | `tags` | 自由主题归类 + 层级路径 | 可选层级化，可选分面前缀 |

**`groups` 的去向**：合并到 `tags` 的命名空间。通过 `group:ch12` 前缀约定实现迁移，FilterBar 的 Group 按钮改为读取 `group:*` 前缀的 tags。

### 3.4 tags 与 fields 的协调规则

| 场景 | 用 tags | 用 fields | 理由 |
|------|:--:|:--:|------|
| 主题概念（数据库、范式） | ✅ | | 主题是归类，不是属性 |
| 层级概念（数据库/范式/BCNF） | ✅ | | 路径式层级，tags 原生支持 |
| 属性维度（难度、来源） | | ✅ | 有明确 key，需要维度内多选 |
| 状态标记（已完成、待复习） | | ✅ | 或者用 flags 更合适 |
| 章节归属（ch12） | ✅ `group:` | | 用前缀分面，保持 tags 统一 |
| 临时标记（重要、收藏） | ✅ | | 无需结构化 |

**决策树**：
```
要标注的是什么？
├── 是认知状态？ → flags (mastery/confidence/needsCorrection)
├── 是标注意图？ → motivation (questioning/commenting/...)
├── 是结构化属性（有明确的 key→value）？
│   ├── key 是预定义维度？ → fields["u:difficulty"] = "进阶"
│   └── key 是临时分组？ → tags: ["group:ch12"]
└── 是主题/概念归类？
    ├── 有层级关系？ → tags: ["数据库/范式/BCNF"]
    └── 是自由标记？ → tags: ["重要"]
```

---

## 4. 实现路径：分 4 个 Phase

### Phase 1: tags 层级化 + groups 归并 (2h)

**目标**：tags 支持层级路径，groups 语义归并到 tags 前缀

**改动**：
```typescript
// filter-engine.ts — 筛选 tags 时支持 prefix 匹配
if (filter.tag && filter.tag !== 'all') {
  const tagVal = filter.tag as string;
  results = results.filter(a => 
    a.tags.some(t => t === tagVal || t.startsWith(tagVal + '/'))
  );
}
```

**groups 兼容**：FilterBar Group 按钮内部改为读取 `group:*` 前缀的 tags + 原有 `groups` 字段（双读兼容）

### Phase 2: FilterBar 统一元数据面板 (3h)

**目标**：将 tags/fields/groups 三个独立筛选入口合并为统一的「元数据」面板

**UI 设计**：
```
┌─ FilterBar 元数据行 ──────────────────────────┐
│ 📋 [Mastery ▾] [# Tags ▾] [🏷️ Fields ▾] [🔗] │
└────────────────────────────────────────────────┘

点击 # Tags ▾:
┌─────────────────────────────────┐
│ 🔍 Search tags...               │
├─────────────────────────────────┤
│ ▸ 数据库 (12)          ← 层级  │
│   ▸ 范式 (8)                   │
│     • BCNF (3)                 │
│     • 3NF (5)                  │
│ ▸ group: (8)          ← 分面前缀│
│   • group:ch12 (5)             │
│   • group:exam (3)             │
│ ▸ 重要 (6)            ← 自由   │
│ ▸ topic: (4)          ← 分面前缀│
│   • topic:事务 (4)             │
└─────────────────────────────────┘
```

**层级标签解析**：tag 中的 `/` 分隔符表示层级，Popover 中按 `/` 分组缩进展示

**分面前缀解析**：tag 中的 `:` 分隔符表示分面维度，Popover 中按前缀分组

### Phase 3: fields 分面升级 (2h)

**目标**：FilterBar 的 `🏷️ Fields` 按钮升级为分面筛选器

**当前**：一次只能加一个 key=value 条件
**升级后**：支持同时选择多个维度的值，AND 组合

```
点击 🏷️ Fields ▾:
┌─────────────────────────────────┐
│ 🔍 Search fields...             │
├─────────────────────────────────┤
│ ▾ difficulty (3 values)         │
│   ☑ 进阶 (12)                  │
│   ☐ 基础 (8)                   │
│   ☐ 高级 (4)                   │
│ ▾ source (2 values)             │
│   ☑ 课本 (15)                  │
│   ☐ 真题 (9)                   │
└─────────────────────────────────┘
```

### Phase 4: 同义词映射 + 标签治理 (4h)

**目标**：Settings 中配置同义词组，搜索/筛选自动扩展

```typescript
// settings 新增
tagSynonyms: Record<string, string[]> = {
  "数据库范式": ["范式", "NormalForm", "NF"],
  "纠偏标记": ["纠错", "correction", "fix"],
};

// filter-engine.ts — 筛选时扩展同义词
function expandSynonyms(tag: string, synonyms?: Record<string, string[]>): string[] {
  const result = [tag];
  // 查找 tag 是否是某个首选术语的同义词
  for (const [preferred, aliasList] of Object.entries(synonyms ?? {})) {
    if (preferred === tag || aliasList.includes(tag)) {
      result.push(preferred, ...aliasList);
    }
  }
  return [...new Set(result)];
}
```

---

## 5. 数据迁移策略

### 5.1 groups → tags 归并

```typescript
// 迁移脚本 (一次性执行)
function migrateGroupsToTags(annotations: Annotation[]): number {
  let migrated = 0;
  for (const ann of annotations) {
    if (ann.groups && ann.groups.length > 0) {
      const groupTags = ann.groups.map(g => `group:${g}`);
      ann.tags = [...new Set([...ann.tags, ...groupTags])];
      // 保留 groups 字段用于双读兼容，但标记为 deprecated
      migrated++;
    }
  }
  return migrated;
}
```

**兼容策略**：
- FilterBar Group 按钮改为双读：先查 `tags` 中的 `group:*`，再查 `groups` 字段
- 新创建的标注不再写入 `groups`，统一用 `tags: ["group:ch12"]`
- 旧数据通过「数据迁移」命令一键升级

### 5.2 tags 层级化

**无需迁移**。现有的 `tags: ["数据库", "范式"]` 可以逐步升级为 `tags: ["数据库/范式"]`，两种格式在筛选时都能工作：

```typescript
// 筛选 "数据库" 时匹配:
// ✅ tags: ["数据库"]           — 精确匹配
// ✅ tags: ["数据库/范式"]       — prefix 匹配
// ✅ tags: ["数据库/范式/BCNF"]  — 深层 prefix 匹配
```

### 5.3 fields 命名空间规范

**无需迁移**。现有的 `u:` 前缀约定保留，新增建议：
- `u:difficulty` / `u:source` / `u:chapter` — 用户自定义
- `_mastery` / `_priority` — 系统内部（已迁移到 flags，保留兼容）

---

## 6. 统一筛选 API 设计

### 6.1 当前 AnnotationFilter 扩展

```typescript
export interface AnnotationFilter {
  // ... 现有字段 ...
  tag?: string | 'all';                    // 单选 tag (已实现)
  tags?: string[];                         // 🆕 多选 tags (AND 逻辑)
  fieldFilters?: Record<string, string>;   // 现有: 单维度单值
  fieldFiltersMulti?: Record<string, string[]>; // 🆕 多维度多值 (分面)
}
```

### 6.2 统一筛选入口

```typescript
// filter-engine.ts
export function applyUnifiedFilter(
  annotations: Annotation[],
  filter: AnnotationFilter,
  searchQuery?: string,
): Annotation[] {
  // ... 现有过滤 ...
  
  // 🆕 多选 tag (AND 逻辑 + 层级 prefix 匹配)
  if (filter.tags && filter.tags.length > 0) {
    results = results.filter(a => {
      return filter.tags!.every(requestedTag => 
        a.tags.some(t => 
          t === requestedTag || 
          t.startsWith(requestedTag + '/') ||
          t.startsWith(requestedTag + ':')  // 分面前缀
        )
      );
    });
  }
  
  // 🆕 分面多值过滤
  if (filter.fieldFiltersMulti) {
    for (const [key, values] of Object.entries(filter.fieldFiltersMulti)) {
      results = results.filter(a => {
        if (!a.fields) return false;
        const annValue = a.fields[key] ?? a.fields['u:' + key];
        return annValue !== undefined && values.includes(annValue);
      });
    }
  }
}
```

---

## 7. 最终架构图

```
┌──────────────────────────────────────────────────────────┐
│                    用户交互层 (UI)                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ FilterBar│  │ Annotation│  │ Settings │  │Relation  │ │
│  │ 统一筛选  │  │  Modal   │  │ 同义词表  │  │  Graph   │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
├───────┼──────────────┼──────────────┼──────────────┼─────┤
│       │     协调层 (Unified Metadata Layer)      │       │
│       ▼              ▼              ▼              ▼       │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  tags 层级解析  +  fields 分面解析  +  同义词扩展    │ │
│  └─────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────┤
│                    数据模型层 (Storage)                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │  tags[]  │  │ fields{} │  │ flags{}  │  │relations[]│ │
│  │ 主题层级  │  │ 结构分面  │  │ 认知状态  │  │ 语义关系  │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │
│  groups[] ← deprecated, 归并为 tags: ["group:xxx"]        │
└──────────────────────────────────────────────────────────┘
```

---

## 8. 对比 v1 方案的改进

| 维度 | v1 方案 | v2 方案 |
|------|---------|---------|
| tags vs fields 关系 | 未分析 | 明确三层职责（认知/分面/主题）|
| groups 处理 | 未提及 | 明确归并到 tags 前缀 |
| 协调机制 | 5 个独立 Phase | 统一元数据层 + 4 个 Phase |
| 筛选统一性 | 各自独立入口 | FilterBar 统一面板 |
| 决策标准 | 模糊 | 明确决策树 |
| 数据迁移 | 未规划 | groups→tags 归并 + 层级兼容 |

---

## 9. 推荐执行顺序

| 优先级 | Phase | 内容 | 工时 | 风险 |
|:--:|:--:|------|:--:|:--:|
| P1 | 1 | tags 层级化 (`/` prefix 匹配) | 2h | 低 |
| P1 | 2 | FilterBar 统一元数据面板 | 3h | 中 |
| P2 | 3 | fields 分面升级 (多维度多值) | 2h | 低 |
| P2 | 4 | 同义词映射 + 标签治理 | 4h | 中 |
| P3 | — | groups→tags 归并迁移 | 2h | 低（双读兼容）|

**推荐先做 Phase 1**（tags 层级化），因为：
1. 改动最小（仅 filter-engine 一处 prefix 匹配）
2. 即时提升体验（考研场景中 `数据库/范式/BCNF` 天然层级）
3. 为后续 Phase 2 统一面板铺路

---

> **文档版本**：v2.0 | **分析人**：Senior Developer (高级开发工程师)
>
> **核心洞察**：MarkVault 的 tags/fields/groups 不是三个独立系统，而是同一元数据层次的不同切面。统一的关键不是合并存储，而是在 UI 和筛选层建立一致的协调机制。
