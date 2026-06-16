# Relation 与知识网络构建 — 深度调研报告

> 调研日期：2026-06-15
> 目标：深度学习 relation/知识网络构建的开源项目，为 MarkVault-JS Phase 6 可视化与闭环提供架构参考

---

## 一、调研项目概览

| 项目 | Stars | 核心领域 | 关键借鉴点 |
|------|-------|----------|------------|
| **Graphiti (Zep)** | 27.4k | 时态知识图谱 | 双时态追踪、事实失效、Episode 溯源 |
| **Trilium Notes** | ~27k | 个人知识库 | Label/Relation 统一属性模型、isInheritable 继承、Relation Map 可视化 |
| **Logseq** | ~34k | 大纲笔记 | EAV 实体模型、Datascript 图查询、ref-type-attributes |
| **AnyType** | ~5k | 本地优先知识库 | Relation-Declaration 分离、Schema-first 建模、双向关系 |
| **Athens Research** | ~6k | 开源 Roam 替代 | Datascript 图数据库、Block Reference 双向链接 |
| **SilverBullet** | ~2k | 可扩展 PKM | 内置数据库 + 查询语言、Plug-in 架构 |
| **Khoj AI** | 35.1k | AI 第二大脑 | RAG + 语义搜索、多格式文档解析 |
| **Letta (MemGPT)** | ~15k | Agent 记忆管理 | 分层记忆（Core/Archival/Recall）、内存分页 |
| **Heptabase** | 闭源 | 白板知识管理 | 视觉化卡片连接、多层级白板组织 |
| **W3C Web Annotation** | 标准 | 标注数据模型 | oa:hasBody/oa:hasTarget、Motivation 本体 |

---

## 二、核心发现与架构模式

### 模式 1：时态知识图谱 — Graphiti 的双时态模型 ⭐⭐⭐

**最值得借鉴的创新**。Graphiti 不把知识图谱当作静态快照，而是随时间演化的活结构。

#### 核心数据模型
```
Entity（节点）
├── name_embedding    — 向量嵌入（语义检索）
├── summary           — 演化中的摘要（随新信息更新）
├── attributes        — 自定义属性字典
└── custom types      — Pydantic 模型定义

Edge（关系/事实）
├── name              — 关系名称
├── fact              — 事实描述文本
├── fact_embedding    — 事实向量（语义检索）
├── valid_at          — 事实生效时间
├── invalid_at        — 事实失效时间（冲突时标记）
├── expired_at        — 系统层过期时间
├── episodes[]        — 溯源到原始数据的 Episode ID
└── attributes        — 关系附加属性
```

#### 关键机制
1. **事实失效（Fact Invalidation）**：当新信息与旧信息矛盾时，旧 Edge 被标记 `invalid_at` 而非删除，历史可回溯
2. **Episode 溯源**：每条 Edge 记录来源 Episode，实现"事实→原始数据"完整血缘
3. **LLM 冲突判断**：新事实入库时，用 LLM 判断与现有事实是否矛盾（阈值 0.2 语义相似度筛选候选 → LLM 裁决）
4. **混合本体**：支持 Pydantic 预定义类型 + 从数据中涌现的类型

#### 对 MarkVault 的启发
- **Relation 时效性**：当前 MarkVault 的 relation 是永久的，学习场景中"曾经关联但现在不再相关"很常见
- **事实溯源**：relation 的 `createdAt` 已有，但缺少 `invalidAt` 和来源 Episode
- **冲突检测**：当两个标注的 relation 矛盾时（如同一概念既"应用"又"对立"），可借鉴 Graphiti 的冲突标记
- **建议增加字段**：`relations[].invalidAt?: number` + `relations[].source?: string`

---

### 模式 2：统一属性模型 — Trilium Notes 的 Label/Relation 统一 ⭐⭐⭐

Trilium 将 Label（键值对）和 Relation（指向另一个 Note 的引用）统一为 **Attribute** 模型。

#### 核心数据模型
```
Attribute
├── type              — 'label' | 'relation'
├── name              — 属性名（如 'author', 'bookReference'）
├── value             — label: 字符串值; relation: 目标 Note ID
├── isInheritable     — 是否继承给子笔记
├── noteId            — 所属笔记
└── position          — 排序位置
```

#### 关键机制
1. **isInheritable 继承**：属性可沿笔记树向下继承，子笔记自动获得父笔记的 Label/Relation
2. **内置 Relation 类型**：`~template`, `~renderNote`, `~widget`, `~imageLink` 等系统关系
3. **Relation Map**：可视化笔记间的关系图（类似 Obsidian 的全局图谱，但基于 Relation 而非 wikilink）
4. **统一查询**：Label 和 Relation 用同一套 API 查询/过滤

#### 对 MarkVault 的启发
- **统一 fields 和 relations**：当前 MarkVault 的 fields（键值对）和 relations（指向标注的引用）是分开的，但 Trilium 证明可以统一为一种 Attribute 模型
- **isInheritable 继承**：如果标注有分组（Group），组级别的 fields/relations 可以继承给组内所有标注
- **内置 Relation 类型**：MarkVault 已有 8 种内置关系类型，可以像 Trilium 一样增加系统级关系（如 `~template`, `~derivedFrom`）
- **Relation Map 可视化**：Phase 6 的 D3.js force-graph 可直接借鉴 Trilium 的 Relation Map 交互模式

---

### 模式 3：EAV 实体模型 — Logseq 的图数据库 ⭐⭐

Logseq 用 Datomic/Datascript 的 EAV（Entity-Attribute-Value）模型存储一切。

#### 核心数据模型
```
Entity（块/页面）
├── :db/id            — 整数 ID
├── :block/uuid       — UUID
├── :block/parent     — 父块引用（构建层级树）
├── :block/page       — 所属页面引用
├── :block/order      — 分数索引（任意位置插入）
├── :block/tags[]     — 多值属性
└── 自定义属性         — :custom/xxx

查询语言：Datalog
  [:find ?title
   :where
   [?b :block/title ?title]
   [?b :custom/author ?author]]
```

#### 关键机制
1. **一切皆实体**：页面和块统一为 Node，通过 `:block/parent` 构建层级
2. **引用即关系**：属性值指向另一个实体的 `:db/id` 就是关系
3. **多值属性**：`card-many-attributes` 机制，一个属性可持有多个值
4. **ref-type-attributes**：区分引用属性和标量属性
5. **分数索引**：`:block/order` 用分数实现任意位置插入，无需重排

#### 对 MarkVault 的启发
- **ref-type 字段**：当前 MarkVault 的 fields 全部是字符串值。可以引入 `ref-type` 概念，区分"值字段"和"引用字段"
- **多值属性**：fields 目前是 `Record<string, string>`，可以考虑 `Record<string, string | string[]>`
- **Datalog 风格查询**：高级搜索可以提供类似 Datalog 的声明式查询语法

---

### 模式 4：Schema-First 关系建模 — AnyType 的声明/值分离 ⭐⭐⭐

AnyType 将 Relation 定义（声明）和 Relation 实例（值）严格分离。

#### 核心数据模型
```
Relation（声明层 — Schema）
├── id                — 关系类型 ID
├── key               — 关系名
├── format            — 值类型（string/number/date/object/select...）
├── multi             — 是否多值
├── objectTypes[]     — 适用的对象类型
└── isHidden          — 是否在 UI 中隐藏

Relation（值层 — Instance）
├── sourceId          — 源对象 ID
├── targetId          — 目标对象 ID（引用类型）
├── relationKeyId     — 关联到 Relation 声明
└── value             — 标量类型直接存值
```

#### 关键机制
1. **声明/值分离**：Relation 类型定义独立于具体的关系实例，一处定义到处使用
2. **双向自动维护**：添加 A → B 关系时，B 自动获得 A 的反向关系
3. **强类型约束**：Relation 声明中定义值类型，实例创建时自动校验
4. **对象类型限定**：Relation 可限制只能连接特定类型的对象

#### 对 MarkVault 的启发
- **这是 MarkVault Phase 5 的 FieldSchema 声明层的最佳参考**
- 当前 MarkVault 的 relation type 是硬编码 8 种，可以改为 Schema-first：用户自定义 RelationType，存入 settings
- **双向自动维护**：当前 MarkVault 已有 `_byRelationOut` + `_byRelationIn` 双索引，但删除关系时需手动同步，应改为自动双向维护
- **类型限定**：未来可限制 Relation 只能连接相同 kind 的标注（如 block→block）

---

### 模式 5：分层记忆 — Letta (MemGPT) 的三级记忆 ⭐⭐

Letta 将 Agent 记忆分为三层，每层有不同的检索和管理策略。

#### 核心数据模型
```
Core Memory（核心记忆）
├── 主系统提示
├── 关键事实摘要
├── 用户偏好
└── 容量有限，LLM 可直接编辑

Archival Memory（归档记忆）
├── 长期知识存储
├── 文档/对话历史
├── 无限容量
└── 通过搜索检索（非直接访问）

Recall Memory（回溯记忆）
├── 对话历史
├── 时间序列
└── 按时间范围检索
```

#### 关键机制
1. **内存分页**：LLM 类似操作系统的虚拟内存，主动"换入/换出"记忆
2. **自主管理**：Agent 自己决定哪些信息放进 Core、哪些归档
3. **搜索驱动的归档检索**：大容量归档记忆通过语义搜索而非遍历访问

#### 对 MarkVault 的启发
- **标注分层**：高频标注（mastery=mastered）= Core；全量标注 = Archival；时间线 = Recall
- **搜索优先 vs 浏览优先**：大量标注场景下，应像 Letta 一样以搜索为主入口，而非侧边栏全量浏览
- **Agent 自主管理**：未来 LLM 集成时，Agent 可以像 Letta 一样自主管理标注的分组/关联

---

### 模式 6：W3C Web Annotation 标准的关系模型 ⭐⭐

W3C 标准定义了标注间的标准关系语义。

#### 核心关系类型
```
oa:replying          — 回复（A 回复 B 的标注）
oa:editing           — 编辑（A 是 B 的编辑版）
oa:highlighting      — 高亮（A 高亮了 B 的部分内容）
oa:commenting        — 评论（A 对 B 发表评论）
oa:questioning       — 提问（A 对 B 提出疑问）
oa:bookmarking       — 收藏（A 收藏了 B）
oa:classifying       — 分类（A 为 B 分类）
oa:linking           — 链接（A 链接到 B）
oa:identifying       — 标识（A 标识 B 是什么）
```

#### 对 MarkVault 的启发
- MarkVault 已实现 Motivation 语义（highlighting/commenting/questioning/editing/bookmarking）
- **缺少 `replying` 和 `classifying`**：这两个 Motivation 对学习场景很有价值
  - `replying`：标注 A 是对标注 B 的回复/回应
  - `classifying`：标注 A 为标注 B 提供分类标签
- **oa:linking**：通用链接关系，类似 MarkVault 的 `relatedTo`

---

## 三、架构模式对比矩阵

| 特性 | Graphiti | Trilium | Logseq | AnyType | Letta | MarkVault 现状 |
|------|----------|---------|--------|---------|-------|---------------|
| 关系存储 | Neo4j/FalkorDB | SQLite | Datascript | 本地 Protocol Buffer | Postgres | 分片 JSON + 内存索引 |
| 时态追踪 | ⭐⭐⭐ 双时态 | ❌ | ❌ | ❌ | ⚠️ 对话级 | ❌ 仅 createdAt |
| 事实失效 | ⭐⭐⭐ 自动 | ❌ | ❌ | ❌ | ❌ | ❌ |
| 双向维护 | ⭐⭐ | ⚠️ 手动 | ⭐⭐ Datascript | ⭐⭐⭐ 自动 | ❌ | ⚠️ 半自动（_byRelationIn） |
| 继承机制 | ❌ | ⭐⭐⭐ isInheritable | ❌ | ❌ | ❌ | ❌ |
| 声明/值分离 | ❌ | ❌ | ❌ | ⭐⭐⭐ Schema-first | ❌ | ❌ 硬编码 8 种 |
| 关系类型化 | Pydantic | 内置+自定义 | ref-type | Schema-first | ❌ | 硬编码枚举 |
| 冲突检测 | ⭐⭐⭐ LLM | ❌ | ❌ | ❌ | ❌ | ❌ |
| 可视化 | ⭐⭐ | ⭐⭐⭐ Relation Map | ⭐⭐ 全局图谱 | ⭐⭐ | ❌ | ❌（Phase 6 计划） |
| 溯源能力 | ⭐⭐⭐ Episode | ❌ | ❌ | ❌ | ⚠️ 对话级 | ❌ |

---

## 四、MarkVault Relation 系统升级建议

### P0 — 立即可做（~50 行代码）

#### 1. Relation 时效性字段
```typescript
interface AnnotationRelation {
  targetUuid: string;
  type: AnnotationRelationType;
  createdAt: number;
  note?: string;
  // 🆕 新增
  invalidAt?: number;      // 关系失效时间（Graphiti 启发）
  source?: string;         // 关系来源（手动/模板/LLM推断）
}
```

#### 2. 补齐 Motivation 类型
```typescript
// 从 W3C Web Annotation 标准补充
type AnnotationMotivation = 
  | 'highlighting' | 'commenting' | 'questioning' 
  | 'editing' | 'bookmarking'
  | 'replying'      // 🆕 回复/回应
  | 'classifying';  // 🆕 分类/归类
```

### P1 — 短期优化（1-2 天）

#### 3. 双向 Relation 自动维护
- 当前：`addRelation(A, B)` 只在 A 的 `relations[]` 中添加，`_byRelationIn` 手动维护
- 升级：`addRelation(A, B, type)` 自动在 B 上创建反向关系 `reverseType`
- 需要定义反向关系映射：`应用↔被应用`、`对立↔对立`、`包含↔属于`、`类似↔类似`

#### 4. Relation 去重增强
- 当前幂等检查：`targetUuid + type` 二元组
- 升级为三元组：`targetUuid + type + invalidAt==undefined`（已失效的关系允许重新创建）

### P2 — 中期架构升级（Phase 6）

#### 5. Schema-First Relation Type（AnyType 启发）
```typescript
interface RelationTypeDefinition {
  id: string;                    // 'applies', 'contradicts', ...
  name: string;                  // 显示名
  reverseTypeId: string;         // 反向关系类型 ID
  description?: string;
  sourceKindConstraint?: Annotation['kind'][];  // 限定源标注类型
  targetKindConstraint?: Annotation['kind'][];  // 限定目标标注类型
  isUserDefined: boolean;        // 系统内置 vs 用户自定义
}
```
存入 `plugin.settings.relationTypeDefinitions[]`，替代硬编码枚举。

#### 6. D3.js Relation Graph 可视化（Trilium Relation Map 启发）
- 节点 = 标注，边 = Relation
- 按 motivation 着色节点，按 relationType 着色边
- 支持：点击节点展开详情、拖拽重排、按 Group 过滤

#### 7. 继承机制（Trilium isInheritable 启发）
- Group 级别的 fields/relations 自动继承给组内标注
- 添加标注到 Group 时，自动获得 Group 的共享 fields 和 relations

### P3 — 远期创新（Phase 7+）

#### 8. LLM 冲突检测（Graphiti 启发）
- 当新添加的 relation 与现有 relation 矛盾时，LLM 判断并标记 `invalidAt`
- 例：标注 A 已有 `对立 → B`，新增 `类似 → B` → 冲突标记

#### 9. Episode 溯源（Graphiti 启发）
- 每条 relation 记录来源 Episode（手动创建/模板创建/LLM 推断/导入）
- 实现 relation → source 的完整血缘

#### 10. 分层记忆（Letta 启发）
- Core = mastered 标注 + 高频 relation
- Archival = 全量标注
- Recall = 最近修改的标注时间线
- LLM 集成时以 Core 为主上下文

---

## 五、关键结论

1. **Graphiti 的时态模型是最值得借鉴的创新** — 学习场景中"知识演变"是常态，relation 应有时效性
2. **AnyType 的声明/值分离是架构最优解** — 让 Relation Type 可扩展、可约束、可反向
3. **Trilium 的继承机制 + Relation Map 是 Phase 6 可视化的最佳参考**
4. **W3C Motivation 标准提供语义互操作性** — 补齐 `replying` 和 `classifying`
5. **MarkVault 当前最大短板不是功能，而是 Relation 的双向自动维护和去重**

**推荐优先级**：P0(时态字段+Motivation 补齐) → P1(双向维护+去重) → P2(Schema-first+可视化) → P3(LLM 冲突+溯源)
