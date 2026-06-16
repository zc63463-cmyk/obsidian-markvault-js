# 元数据底层设计参考分析

> 参考: Obsidian Properties / Dataview / Logseq / Tana / Notion / Roam Research

## 一、现有 MV-JS 元数据模型

```typescript
// 标注间关联 (v4.0)
relations: AnnotationRelation[]  // 出边: 8种 RelationType
// → Store 双向索引: _byRelationOut + _byRelationIn

// 学习状态标记 (v4.0)
flags: AnnotationFlag {
  mastery?: 'unknown' | 'learning' | 'familiar' | 'mastered'
  reviewPriority?: 'low' | 'medium' | 'high' | 'urgent'
  confidence?: 1 | 2 | 3 | 4 | 5
  needsCorrection?: boolean
  lastReviewedAt?: number
  reviewCount?: number
}

// 分组标签 (v4.0)
groups: string[]  // 如 ["ch12", "exam_topics"]

// 自定义字段 (v3.0)
fields: Record<string, string>  // 自由键值对
```

## 二、对标项目元数据设计

### Obsidian Properties — 类型化 YAML Frontmatter

```
类型系统:
  text, number, checkbox, date, datetime, tags, aliases, list

特殊行为:
  - tags: #tag 自动加入全局标签索引, 支持嵌套 tags/a/b
  - aliases: 笔记的备选名称, 链接/搜索时生效
  - date: 支持自然语言输入 "昨天", 自动规范化为 ISO

内部存储:
  - YAML frontmatter: key: value
  - 运行时内存: Map<string, PropertyValue>
  - API: app.metadataCache.getFileCache(file) → frontmatter
```

### Dataview — 元数据查询引擎

```
双层元数据:
  - 显式: YAML frontmatter (page-level)
  - 隐式: file.ctime, file.mtime, file.tags, file.outlinks, file.inlinks
  - 内联: field:: value 写在正文任意位置

查询能力:
  - WHERE mastery = "mastered" AND contains(tags, "db")
  - GROUP BY type, color
  - FLATTEN, SORT, LIMIT

数据类型:
  - string, number, boolean, date, duration, link, array, object
```

### Tana — Supertags（模式化标签）

```
核心理念: 标签携带字段 schema

#definition
  fields: [formal_text, source, context, confidence]

当给节点打上 #definition 标签时,自动展开这四个字段。

这个模式对 MV-JS 极有价值:
  - #definition → 自动设置 flags.confidence 推荐
  - #exam_point → 自动设置 flags.reviewPriority = "high"
  - #key_theorem → 自动设置 flags.mastery = "learning"
```

### Notion — 数据库属性系统

```
属性类型:
  - Select / Multi-select (带颜色)
  - Number (格式化: 数字/百分比/货币)
  - Date (含提醒)
  - Formula (计算属性, 类似 Excel 公式)
  - Relation (跨数据库关联)
  - Rollup (关联数据的聚合值: 计数/求和/平均)
  - Status (工作流状态: 待处理/进行中/已完成)
  - Button (点击触发操作)
```

### Logseq — 块级属性

```
属性可以附加到任意块,而不仅仅是页面:

  * 数据库的三大范式                    ← 块
    definition:: 1NF, 2NF, 3NF          ← 内联属性
    source:: 《数据库系统概论》第6章      ← 内联属性

查询: Datalog 语法
  (and
    [?b :block/properties ?p]
    [(get ?p :mastery) ?m]
    [(= ?m "mastered")])
```

## 三、MV-JS 元数据改进方向

| 改进 | 参考 | 价值 | 工作量 |
|------|------|:---:|:---:|
| **Supertags** — 标签携带字段模板 | Tana | **高** — 减少手动填 Flags 的 friction | 中 |
| **field 类型化** — `Record<string, string>` → 支持 number/date/bool | Obsidian | 高 — 搜索更精准, 数值可排序 | 中 |
| **隐式元数据** — 自动统计 `reviewCount`, `lastModified` | Dataview | 中 — 减少手动维护 | 低 |
| **回链聚合** — 标注间 relations 的 Rollup 视图 | Notion | 中 — 可视化关系价值 | 中 |
| **块级注释属性** — 标注 note 支持结构化字段 | Logseq | 低 — 场景有限 | 高 |

## 四、最值得做的: Supertags

当前创建标注后需要手动去 Modal 填 mastery/priority/group → friction 大。

Supertags 模式: 预设几个"标签模板", 打标签时自动设置元数据:

```typescript
const SUPERTAG_TEMPLATES: Record<string, Partial<AnnotationFlag>> = {
  'key_theorem':   { mastery: 'learning', reviewPriority: 'high' },
  'definition':    { mastery: 'learning', confidence: 5 },
  'exam_point':    { reviewPriority: 'urgent' },
  'needs_review':  { needsCorrection: true },
  'mastered':      { mastery: 'mastered' },
};
```

在 `annotation-modal.ts` 中, 当用户添加 group 或 tag 时, 检查是否匹配 supertag 模板, 匹配则自动填充对应 flags。

**实现量**: ~30 行代码, 零架构变更, 用户可手动覆盖自动填充的值。
