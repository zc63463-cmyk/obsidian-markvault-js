# JSON 数据库项目对比与可借鉴模式

> 调研范围: NeDB / RxDB / LowDB / LokiJS / Dexie.js

## 一、项目对比

| 项目 | Stars | 存储 | 特色 |
|------|:---:|------|------|
| **NeDB** | 13k+ | 追加日志 + 内存 | MongoDB 子集 API, append-only, corruptThreshold |
| **RxDB** | 23k+ | 多后端插件 | Observable 响应式, 本地优先同步, CRDT |
| **LowDB** | 21k+ | 全量 JSON | 极简, adapter 模式 |
| **LokiJS** | 6k+ | 内存 + 持久化 | 唯一/二进制索引 1.1M ops/s, 动态视图 |
| **Dexie.js** | 11k+ | IndexedDB | TypeScript 原生, bulk ops, schema-aware |

## 二、NeDB 的 Append-Only 模式（最值得借鉴）

NeDB 不覆写主文件，而是**追加**变更到文件末尾：

```
数据文件:
{"_id":"a1","text":"数据库","type":"highlight"}     ← 原始
{"_id":"a2","text":"范式","type":"bold"}              ← 原始
{"$$deleted":true,"_id":"a1"}                         ← 删除 a1 → 追加删除行
{"_id":"a1","text":"数据库范式","type":"highlight"}   ← 重新插入 a1 → 追加新行
```

加载时按时间线重放，压缩（compaction）时合并为干净状态。

### 优势

| 特性 | 说明 |
|------|------|
| **写入不损坏已有数据** | 追加失败只丢失新行，不影响历史 |
| **崩溃恢复自然** | 重启时重放 journal → 回到最后一个一致状态 |
| **性能** | 追加 O(1) vs 全量覆写 O(n) |
| **可审计** | 数据文件本身即是变更历史 |

### 适用到 MV-JS

我们的场景：每个 shard 文件包含该文件的所有标注（<100 条）。当前每次 flush 全量覆写已经是合理方案——标注量小，全量 `JSON.stringify` 成本极低。

**但如果要进化**，可以这样设计：

```
shard.json         — 基线数据（compact 产物）
shard.journal      — 追加变更日志（自上次 compact 后）
```

操作流程：
- 新增/修改/删除 → 追加一行到 .journal
- 2s 防抖到期 → 检查 .journal 是否够大（>10行）→ compact 合并到 shard.json
- 加载时 → 读 shard.json + 重放 .journal

## 三、NeDB 的 corruptAlertThreshold（可直接复用）

```typescript
// NeDB 源码模式
if (corruptCount / totalCount > corruptAlertThreshold) {
  throw new Error(`Too much corrupted data: ${corruptCount}/${totalCount}`);
}
```

当前我们的 `_readFileShard` 已经有 checksum 校验 + .bak fallback，但没有"全局损坏率"概念。可以加：

```typescript
// 建议：在 initialize() 中统计所有 shard 的校验失败数
if (corruptShardCount / totalShardCount > 0.3) {
  console.error('MarkVault: 30%+ shards corrupted — refusing to load, manual recovery needed');
  // 提示用户从 MD 文件重新 sync
}
```

## 四、RxDB 的 Schema + Migration（中期可参考）

RxDB 使用 JSON Schema 定义集合结构 + 版本化 migration：

```javascript
schema: { version: 0, primaryKey: 'name', ... },
migrationStrategies: {
  1: (oldDoc) => { /* 升级到 v1 */ },
  2: (oldDoc) => { /* 升级到 v2 */ }
}
```

MV-JS 的 Annotation 类型已经历多次演进（v2.0 kind/blockType, v3.0 fields/format, v4.0 relations/flags/groups）。目前用兼容读取处理旧格式，但没有显式 migration 机制。如果未来 Annotation 结构再变化，这个模式很实用。

## 五、LokiJS 的动态视图（适合性能场景）

```javascript
// 创建一个仅包含 type=highlight 的动态视图
const view = db.addDynamicView('highlights');
view.applyFind({ type: 'highlight' });
// 后续只在这个视图上查询，避免每次全量过滤
```

MV-JS 目前用 `_byType`、`_byColor` 等 Map 索引做预筛选，本质上是同样的模式。12 个索引 Map 已经做到了 LokiJS 级别的 O(1) 查找。

## 六、结论

| 改进 | 来源 | 适用性 | 工作量 |
|------|------|:---:|:---:|
| Append-only journal | NeDB | 中等 — 当前标注量小，全量覆写足够 | 高 |
| corruptAlertThreshold | NeDB | **高** — 直接加在 initialize() 中 | 极低 |
| Schema migration | RxDB | 中期 — Annotation 类型可能继续演进 | 中 |
| Dynamic views | LokiJS | ✅ 已有 — 12 个 Map 索引等价 | — |
| Observable 查询 | RxDB | 低 — Obsidian 无 RxJS 依赖 | 高 |
| TTL 索引 | NeDB | 低 — 标注无自动过期需求 | 中 |

**建议立即实施**: corruptAlertThreshold（<5 行代码），与已有的 checksum 校验搭配形成完整的数据完整性防御。
