# Phase B/C 深度审查报告

> 日期: 2026-06-17 | 审查人: AI Agent | 版本: v5.13

## Phase B: AnnotationFormat + FormatRegistry + vault.process

### 审查范围

| 交付物 | 文件 | 审查结果 |
|--------|------|---------|
| AnnotationFormat 接口 | `format-interface.ts` | 接口设计基本完整，有 2 处设计限制 |
| FormatRegistry 路由层 | `format-registry.ts` | 路由逻辑正确，stripAll 顺序有 Bug |
| MarkFormat 实现 | `mark-format.ts` | fields 联合类型处理有缺陷 |
| NativeFormat 实现 | `native-format.ts` | 功能正确，as any 可优化 |
| BlockFormat 实现 | `block-format.ts` | 双锚点解析完整，strip 正则覆盖正确 |
| RegionFormat 实现 | `region-format.ts` | build() 双锚点不完整 |
| format-setup 初始化 | `format-setup.ts` | 幂等设计正确 |
| vault.process 迁移 | `annotation-modal.ts` | save() 路径有 2 处 Bug |

### 发现的问题

#### B-1 [P1/中] save() vault.process 回调不幂等

**文件**: `annotation-modal.ts` 第 1253-1259 行

```typescript
if (newContent !== content) {
  this.plugin.modifyGuard.acquire(this.annotation.filePath);
  await this.app.vault.process(file, () => newContent);  // ← 基于旧 content 计算
}
```

`vault.process` 的正确用法是回调接收当前文件内容作为参数，从最新内容重新计算变更。但 `save()` 方法先读取 `content`，然后基于旧 `content` 计算 `newContent`，最后闭包传入。如果两次读取之间文件被外部修改（如 Obsidian Sync），`newContent` 会覆盖外部修改。

对比 `remove()` 方法（第 1298-1324 行）正确地在回调内从参数重新计算。

**修复建议**: 在回调内从最新参数重新计算变更，或至少使用 try-finally 保护 modifyGuard。

#### B-2 [P1/中] save() modifyGuard 缺少 try-finally

**文件**: `annotation-modal.ts` 第 1254-1259 行

`vault.process` 抛异常时，`modifyGuard.release()` 不会执行 → 文件路径永久锁定 → 后续所有 sync 操作被阻塞。

对比 `remove()` 方法正确使用了 try-finally（第 1299-1324 行）。

**修复建议**: 改为 try-finally 包裹。
```typescript
this.plugin.modifyGuard.acquire(this.annotation.filePath);
try {
  await this.app.vault.process(file, () => newContent);
} finally {
  this.plugin.modifyGuard.release(this.annotation.filePath);
}
```

#### B-3 [P1/中] stripAll() mark → native 顺序导致 native 标注残留

**文件**: `format-registry.ts` 第 94-106 行

当前顺序: `['mark', 'block', 'region', 'native']`

问题链:
1. MarkFormat.strip() 的正则 `/<mark[^>]*>([\s\S]*?)<\/mark>/g` 匹配**所有** `<mark>` 标签
2. Native 标注的 `<mark class="markvault-native ...">` wrapper 先被 MarkFormat.strip() 剥离
3. 随后 NativeFormat.strip() 调用 `findNativeWrapper()` 查找 `<mark>` wrapper → 找不到 → 锚点 `%%mv:i:...%%` 残留

**修复建议**: 两种方案:
- 方案 A: 调整顺序为 `['native', 'mark', 'block', 'region']`（native 先处理完整结构）
- 方案 B: MarkFormat.strip() 排除 native class:
```typescript
strip(content: string): string {
  return content.replace(/<mark(?![^>]*markvault-native)[^>]*>([\s\S]*?)<\/mark>/g, '$1');
}
```

推荐方案 A，更简洁且语义清晰。

#### B-4 [P2/低] RegionFormat.build() 只返回 start 锚点

**文件**: `region-format.ts` 第 22-25 行

`build()` 接口返回 `string`，但 Region 标注需要 start + end 两个锚点。当前 `build(annotation)` 只返回 `buildRegionAnchor(annotation, 'start')`。

这是一个接口设计限制，不影响运行时（创建流程由 annotation-creator.ts 控制，不通过 build()），但接口语义不完整。

**修复建议**: 长期方案是扩展 `AnnotationFormat.build()` 返回类型为 `string | { start: string; end: string }`，或增加 `buildPair()` 方法。短期无需修改。

#### B-5 [P2/中] MarkFormat.update() 对 Record 类型 fields 静默丢弃

**文件**: `mark-format.ts` 第 35 行

```typescript
fields: typeof changes.fields === 'string' ? changes.fields : undefined,
```

`FormatUpdates.fields` 是 `string | Record<string, string>` 联合类型。当传入 `Record<string, string>` 时，代码将其设为 `undefined`（静默丢弃），而非调用 `encodeFields()` 编码。

**修复建议**:
```typescript
fields: typeof changes.fields === 'string'
  ? changes.fields
  : (changes.fields ? encodeFields(changes.fields) : undefined),
```

#### B-6 [P3/低] parseAll() 去重逻辑设计脆弱

**文件**: `format-registry.ts` 第 54-61 行

去重条件 `ann.format === 'native'` 依赖隐含行为：MarkFormat 不解析 native 标注的 UUID。当前无实际 Bug，但如果 MarkFormat 的解析范围扩展，去重可能失效。

#### B-7 [P3/低] Annotation.format 类型不包含 'block'/'region'

**文件**: `annotation.ts` 第 53 行

`format?: 'mark' | 'native'` 不包含 block/region/span。block/span/region 格式的标注只能依赖 `kind` 字段路由。类型系统没有完整覆盖所有格式种类。

---

## Phase C: 认知数据4层模型 + Schema-First 关系系统

### 审查范围

| 交付物 | 文件 | 审查结果 |
|--------|------|---------|
| Annotation 类型定义 | `annotation.ts` | 4层字段完整，但 confidence 维度缺失 UI 支持 |
| IndexLayer 索引层 | `index-layer.ts` | 缺少 needsCorrection/confidence 索引 |
| PersistLayer 持久化 | `persist-layer.ts` | 分片写入有 .bak 保护，但非真正原子 |
| RelationEngine 关系引擎 | `relation-engine.ts` | reverseId 自洽，级联删除正确 |
| RelationSchema 配置 | `annotation.ts` | 实际 27(16+11) ≠ 声明 30(16+14) |
| strip-fields 清洗 | `strip-fields.ts` | spanRanges/relations 浅拷贝共享嵌套引用 |
| W3C 导入 | `w3c-import.ts` | UUID 重映射不完整 |
| W3C 导出 | `w3c-serializer.ts` | Phase C 字段完整导出 |

### 发现的问题

#### C-1 [P1/高] IndexLayer 缺少 needsCorrection/confidence 索引

**文件**: `index-layer.ts`

IndexLayer 声称 12 个索引，但 AnnotationFlag 的 6 个字段中只有 mastery 和 reviewPriority 有索引。

缺失索引:
- `needsCorrection` (boolean): AnnotationFilter 已定义此过滤字段，QueryEngine 走全量扫描
- `confidence` (1-5): 完全无过滤/统计入口

标注量大时全量扫描是性能瓶颈。

**修复建议**: 增加 `_byNeedsCorrection: Map<boolean, Set<string>>` 和 `_byConfidence: Map<number, Set<string>>` 索引。

#### C-2 [P2/中] stripExtraFields 浅拷贝共享嵌套对象引用

**文件**: `strip-fields.ts` 第 32 行和第 41 行

```typescript
clean.spanRanges = annotation.spanRanges;           // ← 直接赋值引用
clean.relations = [...annotation.relations];         // ← 数组级浅拷贝，内部对象共享
```

- `spanRanges` 是 `SpanRange[]`，每个 `{from, to}` 对象仍是共享引用
- `relations` 是 `AnnotationRelation[]`，数组浅拷贝但每个 relation 对象共享引用

RelationEngine 的 `invalidateRelation`/`restoreRelation` 会**原地修改** relation 对象属性（如 `rel.invalidAt = now`），共享引用可能导致意外副作用。

**修复建议**:
```typescript
clean.spanRanges = annotation.spanRanges?.map(s => ({ ...s }));
clean.relations = annotation.relations.map(r => ({ ...r }));
```

#### C-3 [P2/中] 关系类型实际 27(16+11) ≠ 声明 30(16+14)

**文件**: `annotation.ts`

Memory 和注释中声明 "30 内置类型 = 16 active + 14 passive"，但 `DEFAULT_RELATION_TYPE_CONFIGS` 实际有 27 项 (16 active + 11 passive)。

缺失的 3 个被动类型不存在于配置中。此外 `specializes` 标记为 `isActive: true`，与 Taxonomic 分组的语义方向设计不一致（泛化是主动，特化应由系统自动创建反向关系）。

**修复建议**: 更正声明为 27(16+11)。考虑将 `specializes` 改为 `isActive: false`（纯被动类型），使 Taxonomic 分组只有 `generalizes` 和 `part-of` 是用户可选的。

#### C-4 [P2/中] AnnotationFilter/AnnotationStats 缺少 confidence 维度

**文件**: `annotation.ts`

`AnnotationFilter` 有 mastery/reviewPriority/needsCorrection 过滤，但无 confidence 过滤。
`AnnotationStats` 同样缺少 `byConfidence` 统计。

confidence (1-5) 是间隔复习/学习追踪场景的核心筛选维度。

**修复建议**: 在 AnnotationFilter 增加 `confidence?: 1 | 2 | 3 | 4 | 5 | 'all'`，在 AnnotationStats 增加 `byConfidence: Record<string, number>`。

#### C-5 [P1/高] W3C 导入 UUID 重映射后反向关系引用不完整

**文件**: `w3c-import.ts` 第 286-308 行

`remapRelationUuids` 只修复标注自身 `relations[].targetUuid` 的重映射。但 RelationEngine 的 `addRelation` 在添加正向关系时会自动在目标标注上创建反向关系。当 UUID 冲突策略为 `regenerate` 时:

1. 步骤 3: `addAnnotation(A)` → A 的 relations 引用旧 UUID → RelationEngine 自动在目标标注 B 上创建反向关系 `{targetUuid: old-A}`
2. 步骤 4: `remapRelationUuids` 只修复 A 的出边，不修复 B 上的反向关系入边

结果: B 上的反向关系 `targetUuid` 指向旧 UUID `old-A`，而 Store 中只有 `new-A`。

**修复建议**: 在 remapRelationUuids 完成后，额外扫描所有标注的入边引用，对指向旧 UUID 的条目也做 remap。或在导入时暂不自动创建反向关系，先完成所有 UUID remap，再批量创建反向关系。

#### C-6 [P2/中] PersistLayer 分片写入非原子操作

**文件**: `persist-layer.ts`

写入流程: 写 tmp → 写目标文件 → 删除 tmp。步骤 2 和 3 是两次独立 write，崩溃时可能留下截断 JSON。.bak 提供恢复层，但新数据可能丢失。

**修复建议**: 改为 write tmp → verify checksum → rename tmp to target（Obsidian DataAdapter 可能不直接支持 rename，可用 write + verify 方式替代）。

---

## 修复优先级排序

| 优先级 | 编号 | 修复内容 | 预估工时 |
|--------|------|---------|---------|
| **1** | B-2 | modifyGuard try-finally | 5min |
| **2** | B-3 | stripAll() 顺序调整或 MarkFormat.strip() 排除 native | 15min |
| **3** | C-2 | stripExtraFields 深拷贝 spanRanges/relations | 10min |
| **4** | B-5 + C-4 | MarkFormat fields 编码 + confidence 过滤/统计/索引 | 1h |
| **5** | C-3 | 关系类型声明更正 27(16+11) | 5min |
| **6** | B-1/B-4/C-5/C-6 | 设计改进（vault.process 幂等/双锚点build/W3C remap/原子写入） | 2-3h |

## 确认无问题的设计

| 项目 | 状态 | 说明 |
|------|------|------|
| RelationSchema reverseId 自洽 | ✅ | 27 个类型的 reverseId 双向完全自洽 |
| IndexLayer removeFromIndex | ✅ | 级联删除时序正确（先清理伙伴反向关系，再删除自身索引） |
| W3C 导出 Phase C 字段 | ✅ | 4 层字段完整导出，缺失字段有默认值兜底 |
| AnnotationStats 维度 | ✅ | 除 confidence 外覆盖全部维度 |
| BlockFormat.parse() 与回退路径对齐 | ✅ | 双锚点解析逻辑完全一致 |