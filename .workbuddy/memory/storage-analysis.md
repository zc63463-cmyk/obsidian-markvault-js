# MarkVault-JS 存储系统优化分析

> 基于 LowDB / LokiJS / 通用嵌入式数据库模式调研

## 一、当前架构

```
标注变更 → _markDirty → _scheduleFlush(2s防抖) → _writeFileShard → adapter.write(path, JSON.stringify(data, null, 2))
```

| 特性 | 状态 |
|------|:---:|
| 分片策略 | ✅ 每文件一个 JSON shard（隔离性好） |
| 内存索引 | ✅ 12 个独立 Map（查询 O(1)） |
| 并发保护 | ✅ ModifyGuard + _activeAnnotationUuids + _syncCooldown |
| 写防抖 | ✅ 2s per-file debounce |
| 启动恢复 | ✅ initialize() 预加载 + syncFromMarkdown() |
| 原子写入 | ❌ 直接覆写，无 tmp 文件 |
| 完整性校验 | ❌ 无 checksum |
| 写入备份 | ❌ 无 .bak |
| 崩溃恢复 | ❌ 无 journal |
| 写入性能 | ⚠️ JSON.stringify(data, null, 2) 浪费空间 |

## 二、参考项目模式

### LowDB

- **原子写入**: adapter.write() 承诺 safe atomic writes（具体实现由 adapter 负责）
- **序列化**: 每次 `db.write()` 全量序列化 `db.data`
- **无 schema**: 纯 JS 对象，无 migration 支持
- **设计哲学**: 极简 — 只提供 read/write 接口，其他由用户控制

### LokiJS

- **索引**: 唯一索引 1.1M ops/s，二进制索引 500k ops/s
- **持久化**: 内置 adapter 模式，用户可自定义序列化
- **自动保存**: 支持 autosave + autosaveInterval 节流
- **动态视图**: 索引级别的数据子集快速访问

### 标准嵌入式 DB 模式

| 模式 | 说明 |
|------|------|
| **Write-tmp-rename** | 先写 .tmp 文件，成功后 rename 到目标 → 原子替换 |
| **Checksum** | 写入时附带 SHA-256，读取时校验 → 损坏检测 |
| **Backup rotation** | 保留 .bak（上次成功版本），写入失败可回滚 |
| **Write-ahead log** | 变更先追加到 journal，定期 checkpoint 到主文件 |
| **Compact on write** | 合并碎片 + 移除删除标记后写入 |

## 三、改进提案

### P0: 原子写入（低工作量 / 高价值）

```diff
- await adapter.write(shardPath, JSON.stringify(data, null, 2));
+ const tmpPath = shardPath + '.tmp';
+ await adapter.write(tmpPath, JSON.stringify(data));
+ await adapter.remove(shardPath);  // or rename if supported
+ await adapter.write(shardPath, JSON.stringify(data));
+ await adapter.remove(tmpPath);
```

> 当前 Obsidian DataAdapter 不支持 rename，用 write+remove 近似实现。

### P1: Checksum 完整性校验（中工作量 / 中价值）

```typescript
interface ShardData {
  filePath: string;
  annotations: Annotation[];
  checksum?: string; // SHA-256 of JSON.stringify({filePath, annotations})
}

// 写入时计算 checksum
// 读取时校验 checksum → 不匹配则 fallback 到 .bak 或 rebuild
```

### P1: 写入备份（低工作量 / 中价值）

```typescript
// 写入前先将当前文件复制为 .bak
if (await adapter.exists(shardPath)) {
  const bakPath = shardPath + '.bak';
  const content = await adapter.read(shardPath);
  await adapter.write(bakPath, content);
}
// 然后写入新内容
await adapter.write(shardPath, JSON.stringify(data));
```

### P2: 写入优化（极低工作量 / 低价值）

```diff
- await adapter.write(shardPath, JSON.stringify(data, null, 2));
+ await adapter.write(shardPath, JSON.stringify(data));
```

> pretty-print `null, 2` 增加约 30% 文件体积。观测用 Obsidian 打开 .json 文件时有 beautify 插件。

### P3: 写入重试（低工作量 / 低价值）

```typescript
// 写入失败时自动重试 2 次（间隔 100ms）
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    await adapter.write(shardPath, content);
    break;
  } catch (err) {
    if (attempt === 2) throw err;
    await new Promise(r => setTimeout(r, 100));
  }
}
```

## 四、实施建议

| 优先级 | 改进 | 代码变更 | 风险评估 |
|:---:|------|:---:|:---:|
| **P0** | 原子写入 + 备份 | ~20 行 | 低 — Obsidian adapter 行为已知 |
| **P1** | Checksum | ~30 行 | 低 — 仅增加序列化字段 |
| **P2** | 去掉 pretty-print | 1 行 | 零 — 纯优化 |

**总体评价**: 当前存储系统架构合理（分片 + 内存索引 + 防抖写回），主要缺的是**写入安全面**的防御。三项改进加起来 < 50 行代码变更，没有架构级调整。
