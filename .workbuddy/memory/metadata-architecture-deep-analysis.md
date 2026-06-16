# 元数据底层架构深度分析 — 第二轮

> 本轮聚焦：**数据模型协议层**、**类型系统设计**、**属性元编程**、**标注标准互通**
> 对标项目：AnyType (Protobuf) / Trilium Notes (Attribute) / W3C Web Annotation / Hypothesis / OpenMetadata

---

## 一、对标项目深度解剖

### 1. AnyType — Protobuf Schema-First 的类型元编程系统

**核心设计理念**: 类型(ObjectType) 与 关系(Relation) 都是**一等公民对象**，用 Protobuf 定义，运行时可增删改。

#### 1.1 核心数据模型三角

```
ObjectType ←→ Relation ←→ RelationLink
    │              │           │
    │  relationLinks[]        │
    │  (声明此类型有哪些关系)   │
    │              │           │
    └── details (Struct) ─────┘
        (Relation.key → 实际值存储)
```

**关键洞察**:

| 设计点 | AnyType 实现 | MV-JS 现状 | 差距 |
|--------|-------------|-----------|------|
| **类型定义** | `ObjectType` 是独立对象，有 URL/name/layout/relationLinks | `type` 是 enum (inline/block/span/region) | MV-JS 类型是硬编码的，不可扩展 |
| **关系定义** | `Relation` 是独立对象，有 key/format/name/multi/objectTypes | `AnnotationRelation` 是固定 8 种 enum | MV-JS 关系类型是封闭的 |
| **值存储** | `details: google.protobuf.Struct` — 以 Relation.key 为键的动态 Map | `fields: Record<string, string>` — 自由键值对 | 相似！但 MV-JS 缺少类型约束 |
| **格式系统** | `RelationFormat` 枚举：longtext/shorttext/number/status/date/checkbox/url/email/phone/emoji/tag/object | 全是 `string` | MV-JS 无类型化 |
| **多值支持** | `Relation.multi: bool` + `maxCount: int32` | `groups: string[]`（唯一的数组字段） | MV-JS 几乎无多值字段 |
| **选择字典** | `Relation.selectDict: Option[]` — 带 id/text/color/orderId | 无 | MV-JS 的 mastery/priority 是硬编码 enum |
| **对象引用** | `RelationFormat.object` + `objectTypes[]` 约束可引用的类型 | `AnnotationRelation` 的 targetUuid 引用任意标注 | MV-JS 无类型约束 |
| **轻量引用** | `RelationLink { key, format }` — 不带值，仅声明存在 | 无对应物 | MV-JS 缺少关系声明机制 |

#### 1.2 值与声明分离模式 (最关键借鉴)

AnyType 将**关系声明**与**关系值**分开存储：

```
声明层: ObjectType.relationLinks[] → RelationLink[]
        告诉 UI："这个类型的对象应该有哪些字段"

值层:   SmartBlockSnapshotBase.details → Struct
        存储实际值，key = Relation.key
```

**对 MV-JS 的启示**:
- 当前 `fields` 是无 schema 的自由字典 — 用户可以放任何 key-value
- 可以增加 **FieldSchema 声明层**：定义每个 key 的类型、默认值、可选值
- 不破坏现有数据 — FieldSchema 是可选的元数据，不存入 annotation 本身

#### 1.3 关系格式枚举 (RelationFormat)

```
longtext = 0;   // string — 多行文本
shorttext = 1;  // string — 短文本
number = 2;     // double
status = 3;     // string | list<string> — 单选或多选状态
tag = 11;       // list<string> — 多选标签
date = 4;       // float64 | string
file = 5;       // 文件引用
checkbox = 6;   // boolean
url = 7;        // 带校验的 URL
email = 8;      // 带校验的 email
phone = 9;      // 带校验的电话
emoji = 10;     // 单个 emoji
object = 100;   // 对象引用（可约束 objectType）
relations = 101;// base64 编码的关系内部格式
```

**对 MV-JS 的启示**:
- `fields: Record<string, string>` 应升级为 `fields: Record<string, FieldValue>`
- `FieldValue = string | number | boolean | string[] | Date | UuidReference`
- 这样搜索可以按类型精确匹配（数值范围、布尔过滤、日期区间）

---

### 2. Trilium Notes — Label/Relation 二元属性 + 继承传播

**核心设计理念**: 统一的 Attribute 模型，Label（键值对）和 Relation（指向性链接）是同一张表的不同 type。

#### 2.1 数据模型

```sql
-- Trilium 核心表结构（简化）
CREATE TABLE attributes (
    attributeId   TEXT PRIMARY KEY,
    noteId        TEXT NOT NULL,       -- 所属笔记
    type          TEXT NOT NULL,       -- 'label' | 'relation'
    name          TEXT NOT NULL,       -- 属性名
    value         TEXT NOT NULL DEFAULT '', -- 属性值
    position      INTEGER NOT NULL,    -- 排序
    isInheritable BOOLEAN NOT NULL DEFAULT 0, -- 是否继承
    isDeleted     BOOLEAN NOT NULL DEFAULT 0
);
```

**关键洞察**:

| 设计点 | Trilium 实现 | MV-JS 现状 | 差距 |
|--------|-------------|-----------|------|
| **统一模型** | Label 和 Relation 同表，type 字段区分 | `fields` 和 `relations` 分开存储 | 合理 — 它们语义确实不同 |
| **属性继承** | `isInheritable` — 子笔记自动继承父属性 | 无 | MV-JS 是扁平标注，无树结构，不需要 |
| **Promoted 属性** | 笔记模板定义哪些属性"提升"到封面显示 | 无 | 可借鉴 — 在 Card 上优先显示哪些字段 |
| **系统属性** | `#iconClass`, `#sorted`, `#hidePromotedAttributes` 等 | `mastery`, `reviewPriority` 等硬编码 | MV-JS 的 flags 实质是系统属性 |
| **属性值语法** | `#labelName:labelValue` — 冒号分隔 | `fields: { key: value }` | 本质相同 |
| **关系目标** | Relation.value 指向 noteId | `AnnotationRelation.targetUuid` | 相同 |
| **命名空间** | `#workspace:xxx`, `#label:xxx` — 冒号分隔 | 无命名空间 | 可借鉴，避免字段名冲突 |

#### 2.2 属性继承机制

```
笔记树:
  📁 数据库系统概论 (#sortWeight=10)
    📄 第三章 关系数据库 → 继承 #sortWeight=10
      📝 3.1 关系模型 → 继承 #sortWeight=10
```

**对 MV-JS 的启示**:
- MV-JS 标注是扁平的，无树结构 → 继承不适用
- 但 **Group** 可以做类似的事 — 给 group 加元数据（supertag），组内标注自动获得

---

### 3. W3C Web Annotation Data Model — 标注互操作标准

**核心设计理念**: JSON-LD 格式，标注是"关于资源的资源"，支持选择器(Selector)精确定位。

#### 3.1 核心数据结构

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "id": "urn:uuid:xxxx",
  "type": "Annotation",
  "body": {
    "type": "TextualBody",
    "value": "这是关键定义",
    "format": "text/plain",
    "language": "zh"
  },
  "target": {
    "source": "file:///notes/database.md",
    "selector": {
      "type": "TextQuoteSelector",
      "exact": "关系模型的三类完整性约束",
      "prefix": "...",
      "suffix": "..."
    }
  },
  "motivation": "commenting",
  "created": "2026-06-15T12:00:00Z",
  "creator": {
    "id": "mailto:user@example.com",
    "type": "Person"
  }
}
```

#### 3.2 关键概念对 MV-JS 的映射

| W3C 概念 | 含义 | MV-JS 对应 | 改进建议 |
|----------|------|-----------|---------|
| **Body** | 标注的内容（note/text/tag） | `note: string` + `tags: string[]` | 可扩展为结构化 Body（支持多段 note） |
| **Target** | 被标注的资源+选择器 | `filePath` + 各种锚点 | 已完备 — inline/block/span/region |
| **Selector 类型** | TextQuoteSelector / TextPositionSelector / RangeSelector | 行内锚点 / 行范围 / Span 锚点 / Region 锚点 | 可互操作化 — 导出时映射到 W3C Selector |
| **Motivation** | 标注意图（commenting/tagging/highlighting/questioning） | 无 | **高价值** — 分类标注语义，驱动学习流程 |
| **Agent (Creator)** | 创建者身份 | 无 | 低优先 — 个人工具不需要 |
| **Stylesheet** | 标注的可视化样式 | `color` + `type` (bold/highlight/underline) | 已完备 |

#### 3.3 Motivation 枚举的借鉴价值

```
commenting     → 评论/笔记（当前 note 字段）
tagging        → 分类标注（当前 tags 字段）
highlighting   → 纯高亮（当前 type=highlight 无 note）
questioning    → 提问（MV-JS 缺失！学习场景高频）
replying       → 回复/讨论（MV-JS 缺失）
bookmarking    → 书签/收藏（MV-JS 缺失）
editing        → 修正建议（对应 needsCorrection）
moderating     → 审核/复核（对应 reviewPriority）
```

**对 MV-JS 的启示**:
- `motivation` 字段可以直接替代/增强现有 `type` 的语义维度
- 学习场景下，`questioning` 和 `editing` 是极高频操作
- 可以用 `motivation` 驱动学习闭环：questioning → commenting → mastered

---

### 4. Hypothesis — PostgreSQL + Elasticsearch 双层标注存储

**核心设计理念**: 关系型存储保证 ACID，搜索引擎保证查询性能，标注遵循 W3C 模型。

#### 4.1 数据模型

```python
# Hypothesis annotation 核心字段
class Annotation:
    id: str              # UUID
    userid: str          # 用户标识
    groupid: str         # 分组（类似 MV-JS 的 groups）
    target_uri: str      # 被标注的 URI（类似 filePath）
    target_selectors: [] # W3C Selectors
    text: str            # 标注正文
    tags: [str]          # 标签
    references: [str]    # 回复链（父标注 ID）
    created: datetime
    updated: datetime
    shared: bool         # 公开/私有
    document: dict        # 被标注文档的元数据
    extra: dict          # 扩展数据（类似 fields）
```

#### 4.2 架构启示

| 设计点 | Hypothesis 实现 | MV-JS 现状 | 可借鉴 |
|--------|----------------|-----------|--------|
| **双层存储** | PostgreSQL(主) + Elasticsearch(搜索) | JSON 分片(主) + 内存倒排索引(搜索) | 已类似！ |
| **分组** | `groupid` — 标注属于哪个群组 | `groups: string[]` — 标注属于多个组 | MV-JS 更灵活 |
| **回复链** | `references: [parentAnnotationId]` | `AnnotationRelation` 的 `references` 类型 | MV-JS 有！ |
| **文档元数据** | `document: { title, ... }` — 被标注文档的元信息 | `filePath` — 仅存路径 | 可扩展文档元数据 |
| **共享/私有** | `shared: bool` | 无 | 个人工具不需要 |
| **N+1 选择器** | 一个 target 可以有多个 selector | 一种锚点类型对应一个选择器 | MV-JS 的锚点更精确 |

---

### 5. OpenMetadata — Schema-First 的元数据治理标准

**核心设计理念**: JSON Schema 定义所有实体类型，代码生成保证类型安全，700+ Schema 覆盖完整元数据生命周期。

#### 5.1 关键设计模式

```
Schema-First 流程:
  1. JSON Schema 定义 Entity (如 Database, Table, Column)
  2. 代码生成 Entity 类 + Repository + API
  3. Entity Relationship 通过 JSON Schema 的 $ref 交叉引用
  4. 变更走 Schema 迁移，保证向后兼容
```

#### 5.2 对 MV-JS 的启示

| 设计点 | OpenMetadata 实现 | MV-JS 可借鉴 |
|--------|------------------|-------------|
| **Schema 版本化** | 每个 Entity 有 schemaVersion | 给 `Annotation` 加 `schemaVersion` 字段，未来升级迁移 |
| **Entity Relationship** | 通过 JSON Schema $ref 定义实体间关系 | 可用 JSON Schema 定义 Annotation ↔ AnnotationRelation 的约束 |
| **Lineage** | 数据血缘 — 上游→下游的关系图 | 知识图谱的"关联图" — 标注间推理链 |
| **变更事件** | EntityChangeEvents — 实体变更触发事件 | 标注变更事件 — 驱动 UI 刷新、搜索索引更新 |

---

## 二、跨项目模式提炼

### 模式 1: 值与声明分离 (AnyType)

```
当前 MV-JS:
  annotation.fields = { "source": "教材", "difficulty": "3" }
  问题: 所有值都是 string，无类型约束，无 UI 提示

升级:
  FieldSchema = { key: "difficulty", type: "number", min: 1, max: 5, default: 3 }
  FieldSchema = { key: "source", type: "shorttext", suggestions: ["教材","论文","博客"] }
  annotation.fields = { "source": "教材", "difficulty": 3 }  // 类型化值

  声明层: FieldSchema[] — 可存 settings 或独立 JSON
  值层:   annotation.fields — 保持 Record<string, FieldValue>
```

### 模式 2: 属性命名空间 (Trilium)

```
当前 MV-JS:
  fields = { "source": "xx", "chapter": "3" }
  问题: 用户自定义 key 可能与系统 key 冲突

升级:
  系统命名空间: _mastery, _priority, _confidence (已有 flags)
  用户命名空间: u:source, u:chapter, u:difficulty
  预设模板命名空间: t:definition, t:exam_point (supertag)
```

### 模式 3: Motivation 语义层 (W3C)

```
当前 MV-JS:
  annotation.kind = 'inline' | 'block' | 'span' | 'region'  ← 位置类型
  annotation.type = 'bold' | 'highlight' | 'underline'        ← 视觉类型

缺失维度: 语义类型 — WHY you annotated this?

升级:
  annotation.motivation = 'commenting' | 'highlighting' | 'questioning' | 'editing' | 'bookmarking'

  场景:
  - 高亮关键句 → motivation: highlighting
  - 写笔记解释 → motivation: commenting
  - 标记不理解 → motivation: questioning
  - 建议修正 → motivation: editing (→ needsCorrection)
```

### 模式 4: Schema 版本化 (OpenMetadata)

```
当前 MV-JS:
  Annotation 接口无版本号，数据格式升级靠代码中的兼容逻辑

升级:
  interface Annotation {
    schemaVersion: 1;  // 当前版本
    // ... 其他字段
  }

  未来升级路径:
  - v1 → v2: fields: Record<string, string> → Record<string, FieldValue>
  - 迁移函数: migrateV1ToV2(annotation) → Annotation
  - 加载时自动迁移: if (a.schemaVersion === 1) a = migrateV1ToV2(a)
```

### 模式 5: W3C 互操作导出层

```
当前 MV-JS 导出: 自定义 JSON + Markdown

升级: 增加 W3C Web Annotation 格式导出
  - 每个标注 → W3C Annotation JSON-LD
  - inline 锚点 → TextQuoteSelector
  - block 锚点 → CssSelector + RangeSelector
  - region 锚点 → RangeSelector
  - relations → oa:hasTarget 链式引用

价值: 标注数据可与 Hypothesis/PDF.js/其他 W3C 兼容工具互操作
```

---

## 三、对 MV-JS 架构的具体升级建议

### P0 (高价值 + 低成本) — 立即可做

| # | 改进 | 参考 | 预估 |
|---|------|------|------|
| 1 | **Schema 版本化** — `schemaVersion: 1` 加入 Annotation 接口 | OpenMetadata | 5 行 |
| 2 | **Motivation 语义层** — 新增 `motivation` 可选字段 | W3C Web Annotation | 20 行 |
| 3 | **字段命名空间** — `u:` 前缀区分用户字段 | Trilium | 10 行 |

### P1 (高价值 + 中成本) — Phase 5 时做

| # | 改进 | 参考 | 预估 |
|---|------|------|------|
| 4 | **FieldValue 类型化** — `string → string | number | boolean | string[]` | AnyType RelationFormat | 150 行 |
| 5 | **FieldSchema 声明层** — settings 中定义字段模板 | AnyType ObjectType.relationLinks | 200 行 |
| 6 | **W3C 互操作导出** — 导出时映射到 W3C 格式 | W3C Web Annotation | 300 行 |

### P2 (中等价值 + 高成本) — 远期

| # | 改进 | 参考 | 预估 |
|---|------|------|------|
| 7 | **开放 Relation 类型** — 用户自定义关系类型 | AnyType Relation | 500 行 |
| 8 | **Motivation 驱动学习闭环** — questioning → commenting → mastered 自动流程 | W3C + SRS | 800 行 |
| 9 | **标注变更事件总线** — onChange 触发索引/统计/UI 更新 | OpenMetadata EntityChangeEvents | 400 行 |

---

## 四、各项目架构对比矩阵

| 维度 | AnyType | Trilium | W3C | Hypothesis | OpenMetadata | MV-JS 现状 |
|------|---------|---------|-----|-----------|-------------|-----------|
| **类型系统** | Protobuf enum + 运行时可扩展 | 无（字符串） | JSON-LD @type | 无（Python class） | JSON Schema | TypeScript interface |
| **属性格式** | 15 种 RelationFormat | 字符串 | JSON-LD 值 | JSON 字段 | JSON Schema type | string only |
| **关系模型** | Relation 对象 + 双向 | Relation 行 + isOwnedBy | oa:hasTarget | references[] | EntityRelationship | 8 种 enum |
| **继承** | ObjectType → 实例 | isInheritable | 无 | 无 | Schema 继承 | 无 |
| **Schema 演化** | protobuf 版本号 | DB 迁移 | @context 版本 | DB 迁移 | schemaVersion | 无 |
| **互操作性** | Protobuf 跨平台 | 无 | JSON-LD 标准 | W3C 兼容 | JSON Schema 标准 | 自定义 JSON |
| **搜索** | 全文 + 关系查询 | SQL LIKE | 无 | ES 全文 | ES/OpenSearch | BM25 + 倒排索引 |
| **本地优先** | 是（CRDT 同步） | 是（SQLite） | N/A（标准） | 否（服务端） | 否（服务端） | 是（JSON 分片） |

---

## 五、最核心的一个借鉴：AnyType 的 "值与声明分离"

这是本轮分析最有价值的发现。AnyType 的核心创新不是 Protobuf，而是：

**关系声明（Relation 定义）独立于关系值（details 中的值）**

这意味着：
1. **UI 知道该显示什么** — 根据 ObjectType.relationLinks 知道该类型有哪些字段
2. **搜索知道该按什么过滤** — 根据 Relation.format 知道字段类型，可做精确过滤
3. **新类型零代码扩展** — 定义新的 ObjectType + Relation 组合，不需要改代码
4. **迁移安全** — 新增 Relation 不影响旧数据

**映射到 MV-JS**:

```
当前:
  Annotation { fields: { "source": "教材" } }  // 无类型，无 schema

升级:
  // 声明层（存在 settings 或独立 JSON）
  FieldSchemas = [
    { key: "source", type: "shorttext", suggestions: ["教材","论文","博客"] },
    { key: "difficulty", type: "number", min: 1, max: 5 },
    { key: "reviewDate", type: "date" },
  ]

  // 值层（存在 annotation 中，类型化）
  Annotation { fields: { "source": "教材", "difficulty": 3, "reviewDate": "2026-06-20" } }

  // 好处:
  // 1. FilterBar 可以按类型渲染（数值滑块、日期选择器、下拉建议）
  // 2. 搜索引擎可以按类型精确匹配（数值范围、日期区间）
  // 3. 新增字段不需要改代码
  // 4. 现有数据完全兼容 — 无 schema 的字段仍当 string 处理
```

这个模式不需要 MV-JS 实现 Protobuf，只需要一个简单的 FieldSchema JSON 定义 + 类型化的 FieldValue 联合类型。
