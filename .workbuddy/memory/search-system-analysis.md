# MarkVault-JS 搜索系统升级分析

> 基于 MiniSearch / Orama / FlexSearch 三家热门全文搜索库的调研

## 一、热门项目概览

| 项目 | Stars | 体积 | CJK | 评分算法 | 模糊搜索 | 独特优势 |
|------|-------|------|-----|---------|---------|---------|
| **MiniSearch** | 6k+ | ~6KB gzip | 需自定义 | BM25 变体 | 编辑距离 | 零依赖、JSON 序列化、autoSuggest |
| **Orama** | 10.4k | <2KB | 30语言内置 | BM25 | 内置 typo tolerance | 向量搜索、RAG、插件系统、facets |
| **FlexSearch** | 12k+ | 4.5~16KB | 内置 Charset.CJK | 上下文距离 | 多层模糊 | 极致速度、多后端持久化、Worker |

## 二、当前 MarkVault-JS 搜索 vs 行业标杆

### 现有能力

```
✅ 倒排索引 → Map<token, Set<uuid>>
✅ CJK bigram 分词器（自研，覆盖 Extension A/B/C）
✅ 字段加权评分（text:10, note:7, tags:5, filePath:4, groups:3, fields:2, uuid:8）
✅ Bigram OR + other OR 搜索语义
✅ 统一过滤引擎（12维 filter + 3种排序）
✅ suggest() 自动补全
✅ 批量过滤（applyUnifiedFilter 一次调用）
✅ O(1) 索引一致性检测（getAnnotationCount）
```

### 缺失能力

| 能力 | MiniSearch | Orama | FlexSearch | 当前 MV-JS |
|------|:---:|:---:|:---:|:---:|
| BM25 评分 | ✅ | ✅ | ❌ | ❌ (简单加权) |
| 模糊/容错搜索 | ✅ | ✅ | ✅ | ❌ |
| 上下文距离评分 | ❌ | ❌ | ✅ | ❌ |
| 索引持久化 | ✅ | 插件 | ✅ | ❌ (每次重建) |
| 短语搜索 | ❌ | ❌ | ❌ | ❌ |
| 前缀搜索 | ✅ | ❌ | ❌ | ❌ |
| 搜索结果 facets | ❌ | ✅ | ❌ | ❌ |
| 高亮信息 | ✅ | ❌ | ✅ | 部分 |
| Worker 并行 | ❌ | ❌ | ✅ | ❌ |
| Stop words | 自定义 | 内置 | 内置 | ❌ |
| 向量搜索 | ❌ | ✅ | ❌ | ❌ |

## 三、对比当前实现的具体改进

### 改进 1: BM25 评分（高价值 / 中工作量）

**现状**: 简单加权和 + cap 3

```typescript
// 当前
totalScore += weight * bonus * Math.min(fieldHits[field], 3);
```

**问题**:
- 不区分文档长度（长文档天然更多命中）
- 不区分 token 稀有度（常见 token 应降权）
- cap=3 是硬编码，缺乏理论支撑

**BM25 方案**:
```
score(D, Q) = Σ IDF(qi) × (f(qi,D) × (k1+1)) / (f(qi,D) + k1 × (1-b+b × |D|/avgDL))

IDF(qi) = ln((N - n(qi) + 0.5) / (n(qi) + 0.5) + 1)
```

- **IDF** 稀有 token 权重更高（如 "范式" > "数据库"）
- **TF saturation** k1=1.5 防止词频过高主导评分
- **长度归一化** b=0.75 长文档不天然占优

**落地**: 在 `_searchByTokens` 中加入 IDF 计算和 BM25 公式，保持向后兼容（option: scoringModel: 'weighted' | 'bm25'）

### 改进 2: 模糊搜索（高价值 / 中工作量）

**现状**: 精确匹配 only

**问题**: "酸" 不会匹配到 "算", "transaction" 不会匹配到 "trasaction"

**方案**: Levenshtein 编辑距离（MiniSearch 方式）

```typescript
// fuzzy: 0.2 → 允许编辑距离 = floor(token.length × 0.2)
// "批注" (2 chars) → ed=0 → 不模糊
// "数据库" (3 chars) → ed=0 → 不模糊  
// "transaction" (11 chars) → ed=2 → 容忍2个编辑
search({ query: '数据库', fuzzy: 0.15 })  // 英文词模糊，CJK bigram 不模糊
```

**落地**: 在 `_searchByTokens` 中仅对 English token 启用模糊匹配（CJK bigram 长度短，模糊意义有限）；新增 `fuzzy` 搜索选项

### 改进 3: 前缀搜索（中价值 / 低工作量）

**现状**: 用户输入 "数据" → 只匹配含 bigram "数据" 的条目，不匹配 "数据库索引" 中未出现 "数据" bigram 的条目

**方案**: MiniSearch `prefix: true`

```typescript
// 搜索 "数据" with prefix=true → 匹配所有以 "数据" 开头的 indexed tokens
// 倒排索引中 "数据", "数据库", "数据表" 全部命中
```

**落地**: 遍历倒排索引，找所有以 query 为前缀的 token key，合并其 uuid set

### 改进 4: 索引持久化（中价值 / 中工作量）

**现状**: 每次插件加载或 markDirty → 全量重建倒排索引（O(n×m) 每标注 × 每字段 × tokenize）

**方案**: MiniSearch 的 JSON 序列化 / FlexSearch 的 IndexedDB

```typescript
// 序列化
const serialized = JSON.stringify({
  invertedIndex: [...engine._invertedIndex.entries()],
  indexedCount: engine._indexedCount,
});
await vault.adapter.write(indexPath, serialized);

// 反序列化
const data = JSON.parse(await vault.adapter.read(indexPath));
engine._invertedIndex = new Map(data.invertedIndex.map(([k, v]: [string, string[]]) => [k, new Set(v)]));
```

**落地**: 新增 `saveIndex()` / `loadIndex()` 方法；首次加载 500+ 标注时省 ~200ms

### 改进 5: 短语搜索（中价值 / 中工作量）

**现状**: "关系数据库" → 匹配所有含 "关系" + "数据" + "据库" 任意一个的条目（bigram OR），可能返回顺序/距离无关的条目

**方案**: 双引号触发短语模式 `"关系数据库"` → 必须连续出现

```typescript
// 解析 query: "关系数据库" 范式 → phrase=["关系数据库"] + tokens=["范式"]
// 用 indexOf 检查 text/note 中是否包含完整短语
```

**落地**: 在 `tokenizeQuery` 中增加双引号短语检测；在 filter/search 中增加 `includes(phrase)` 检查

### 改进 6: 搜索 Facets（中价值 / 中工作量）

**现状**: 搜索结果只返回匹配列表，不显示按类型/颜色/掌握度/分组的分布

**方案**: Orama 风格的 facets 聚合

```typescript
search({ query: '数据库', facets: true })
// 返回额外字段:
{
  results: [...],
  facets: {
    type: { highlight: 15, bold: 8, underline: 3 },
    color: { yellow: 12, green: 7, blue: 5, ... },
    mastery: { unknown: 5, learning: 8, familiar: 10, mastered: 3 },
    groups: { ch12: 5, exam_topics: 3, ... }
  }
}
```

**落地**: 在 `SearchResult` 中扩展 `facets` 字段；search() 末尾额外遍历结果集做聚合（O(results)）

### 改进 7: 上下文距离评分（低价值 / 低工作量）

**现状**: 评分只看字段命中次数，不关心 token 之间的距离

**方案**: FlexSearch 的 context 评分 — 搜索词在文本中距离越近，额外加分

```typescript
// 在 _countFieldHits 后额外计算 token 间最小距离
const proximity = computeMinDistance(ann.text, tokens);
if (proximity < 20) totalScore += (20 - proximity) * 0.5; // 距离越近加分越多
```

**落地**: 在评分阶段加入 `_computeProximityBonus`；仅对有搜索词的场景启用

### 改进 8: Stop Words（低价值 / 极低工作量）

**现状**: "的", "是", "在", "the", "a", "an" 等高频词被 tokenize 为有效 token，占索引空间且不增加区分度

**方案**: 内置 stop words 列表，tokenize 后过滤

```typescript
const STOP_WORDS = new Set(['的', '了', '在', '是', '我', 'the', 'a', 'an', 'is', 'of', 'to', 'in']);
// tokenize 后在 return 前过滤
```

**落地**: tokenizer.ts 增加 `STOP_WORDS` 常量 + 过滤逻辑

## 四、不建议引入的特性

| 特性 | 原因 |
|------|------|
| **向量搜索** (Orama) | 需要 embedding API/模型，Obsidian 插件离线场景不适配 |
| **Worker 并行** (FlexSearch) | Obsidian 插件环境受限，且当前数据规模不需要 |
| **多后端持久化** (FlexSearch) | 只需要本地 JSON 序列化即可 |
| **RAG 管道** (Orama) | Phase 5 Export 已覆盖 LLM 集成场景 |
| **CJK stemming** | CJK 无形态变化，stemming 无意义 |

## 五、推荐实施优先级

| 优先级 | 改进项 | 工作量 | 用户可感价值 |
|--------|--------|--------|------|
| **P1 🔴** | BM25 评分 | 中 | 搜索结果质量显著提升 |
| **P1 🔴** | 模糊搜索（英） | 中 | 英文拼写容错，提升召回 |
| **P2 🟡** | 前缀搜索 | 低 | 输入中实时反馈更好 |
| **P2 🟡** | 索引持久化 | 中 | 插件启动加速 |
| **P3 🟢** | 短语搜索 | 中 | 精确语义搜索 |
| **P3 🟢** | 搜索 Facets | 中 | 结果导航体验升级 |
| **P4 ⚪** | 上下文距离评分 | 低 | 小幅度精度提升 |
| **P4 ⚪** | Stop Words | 极低 | 索引体积微减 |

## 六、总体评估

MarkVault-JS 的自研搜索系统在 **CJK 分词**方面已经达到行业先进水平（覆盖 Extension A/B/C、bigram OR 语义、共享 isCJK），但在 **评分算法** 和 **容错能力** 两个维度有明确的提升空间。建议优先实施 BM25 + 模糊搜索两项，以较小的代码增量换取搜索结果质量的显著提升。
