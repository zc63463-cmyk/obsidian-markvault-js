# Phase C 实施规划

> 日期: 2026-06-17
> 状态: 规划阶段

## 现状分析

| 提案 | 已有基础 | 缺口 | 工时 | ROI |
|------|----------|------|------|-----|
| C-3 孤儿标注 | `cleanOrphanAnnotations()` 手动触发 | 自动检测/可视化/逐条确认/统计 | 3h | ★★★★★ |
| C-4 模板引擎v2 | 5 静态预设 + `AnnotationTemplate` 接口 + 右键菜单 | 动态模板/CRUD/认知模板/快捷键绑定 | 3h | ★★★★ |
| C-1 哈希锚点 | `targetHash` + `computeSignature` 已全面使用 | 确定性偏移锚点(hash→locate) | 5h | ★★★ |
| C-2 快照历史 | 搜索索引 snapshot 已有 | 标注版本快照/undo/diff UI | 5h | ★★ |

## Phase B 完成确认

Phase B (AnnotationFormat + FormatRegistry + vault.process) **已完成** ✅

- ✅ B-1: AnnotationFormat 接口 (format-interface.ts, ~30行)
- ✅ B-1a~1f: 5 个格式实现 (mark/native/block/region) + FormatRegistry 路由
- ✅ B-2: vault.process() 事务性写入 (annotation-modal.ts)
- ✅ Phase H 加固: BUG-13~17 修复, 412/412 测试通过

---

## C-3 孤儿标注检测与清理增强 (3h)

### 现有基础

```typescript
// annotation-repo.ts: cleanOrphanAnnotations(app, store)
// context-menu.ts: 右键菜单 "Clean orphan annotations" → 手动触发
```

### 增强目标

| 功能 | 说明 | 工时 |
|------|------|------|
| **自动检测** | 文件打开时自动检测孤儿标注，不自动删除（仅警告） | 1h |
| **OrphanPanel** | 侧边栏新增"孤儿标注"面板，显示列表+原因+预览 | 1h |
| **逐条确认** | Modal 弹窗逐条确认删除，避免批量误删 | 0.5h |
| **统计面板** | AnnotationStats 增加 orphanCount 字段 | 0.5h |

### 实施步骤

#### C-3.1: 自动检测引擎 (1h)

**文件**: `src/db/orphan-detector.ts` (新增)

```typescript
export interface OrphanInfo {
  uuid: string;
  filePath: string;
  reason: 'file_deleted' | 'anchor_missing' | 'content_changed';
  lastSeenContent?: string;  // DB 中的最后已知内容
  detectedAt: number;
}

export async function detectOrphans(app: App, store: AnnotationStore): Promise<OrphanInfo[]> {
  // 1. 遍历所有标注
  // 2. 对每个标注的 filePath:
  //    a. 文件不存在 → reason='file_deleted'
  //    b. 文件存在但 parse 后找不到 UUID → reason='anchor_missing'
  // 3. 返回 OrphanInfo[]（不执行删除）
}
```

**集成**: `src/main.ts` 在 `onFileOpen` 事件中调用 `detectOrphans()`，结果缓存到实例属性 `this._orphanCache`。

#### C-3.2: OrphanPanel 侧边栏 (1h)

**文件**: `src/ui/sidebar/orphan-panel.ts` (新增)

- 侧边栏 tab 增加 "Orphans" 视图
- 显示: 文件名 / 标注内容摘要 / 孤立原因 / 检测时间
- 操作: "Delete" / "Dismiss" 按钮

#### C-3.3: 逐条确认 Modal (0.5h)

**文件**: `src/ui/orphan-confirm-modal.ts` (新增)

- Obsidian Modal，显示孤儿标注详情
- 选项: "Delete" / "Keep" / "Delete All for this file"

#### C-3.4: 统计增强 (0.5h)

**文件**: `src/types/annotation.ts` + `src/db/annotation-store.ts`

- AnnotationStats 增加 `orphanCount: number`
- `getAnnotationStats()` 计算孤儿数量

---

## C-4 模板引擎 v2 (3h)

### 现有基础

```typescript
// annotation.ts: AnnotationTemplate 接口 (id/name/type/color/motivation/fields/tags/icon/hotkey)
// annotation.ts: DEFAULT_ANNOTATION_TEMPLATES (5个静态预设)
// context-menu.ts: 右键菜单动态注册模板项
// annotation.ts: FieldTemplate / FieldDef (2个 fieldTemplate: academic/reading)
```

### 增强目标

| 功能 | 说明 | 工时 |
|------|------|------|
| **动态模板生成** | 基于 fieldTemplate 自动生成 AnnotationTemplate | 1h |
| **自定义模板 CRUD** | Settings 中用户增删改模板 | 1h |
| **认知模板** | 自动填充 flags 维度的模板 | 0.5h |
| **快捷键绑定** | 模板→Obsidian 命令→快捷键 | 0.5h |

### 实施步骤

#### C-4.1: 动态模板生成器 (1h)

**文件**: `src/core/template-generator.ts` (新增)

核心逻辑：将 `FieldTemplate` 转换为 `AnnotationTemplate`

```typescript
export function generateTemplatesFromFieldTemplates(
  fieldTemplates: FieldTemplate[],
  motivations: AnnotationMotivation[],
): AnnotationTemplate[] {
  // 为每个 fieldTemplate × motivation 组合生成模板
  // 例: academic × highlighting → "学术高亮" (type=highlight, color=yellow, fields={category, importance})
  // 例: academic × questioning → "学术提问" (type=highlight, color=pink, fields={category, understanding})
}
```

**集成**: `MarkVaultSettings.annotationTemplates` 不再硬编码 5 个预设，而是:
- 基础 = `DEFAULT_ANNOTATION_TEMPLATES` (5 个)
- 动态 = `generateTemplatesFromFieldTemplates(fieldTemplates, motivations)`
- 用户自定义 = settings 中保存的 `customTemplates[]`
- 合并: `base + dynamic + custom`

#### C-4.2: 模板设置 CRUD (1h)

**文件**: `src/ui/settings/template-settings.ts` (新增)

- Settings tab 增加 "Templates" 子页
- UI: 列表视图 + 增删改操作
- 每个模板可编辑: name/type/color/motivation/fields/tags/icon
- 保存到 `MarkVaultSettings.customTemplates[]`

#### C-4.3: 认知模板 (0.5h)

新增 3 个认知维度模板:

```typescript
// 新增默认模板
{ id: 'mastery-review', name: '掌握度复查', type: 'highlight', color: 'green',
  motivation: 'reviewing', flags: { mastery: 'reviewing', reviewPriority: 'high' } },

{ id: 'needs-correction', name: '待纠偏', type: 'highlight', color: 'red',
  motivation: 'editing', flags: { needsCorrection: true, reviewPriority: 'high' } },

{ id: 'confidence-check', name: '置信度标记', type: 'underline', color: 'orange',
  motivation: 'questioning', flags: { confidence: 2 } },
```

**扩展**: `AnnotationTemplate` 接口增加 `flags?: Partial<AnnotationFlag>` 字段。

#### C-4.4: 快捷键绑定 (0.5h)

**文件**: `src/main.ts` 命令注册

```typescript
// 为每个模板注册 Obsidian 命令
for (const tpl of settings.annotationTemplates) {
  this.addCommand({
    id: `annotate-template-${tpl.id}`,
    name: `Annotate: ${tpl.name}`,
    callback: () => createAnnotationFromTemplate(this, editor, view, tpl),
  });
}
```

用户可在 Obsidian 快捷键设置中绑定。

---

## C-1 哈希锚点 (5h) — 低优先级

### 现有基础

`targetHash` + `computeSignature()` + `computeBlockSignature()` + `computeSpanSignature()` 已全面使用于:
- annotation-parser.ts (双锚点/单锚点解析)
- block-format.ts (Format 路径解析)
- annotation-creator.ts (创建时计算)
- sync-engine.ts (偏移恢复)
- markdown-sync.ts (同步校验)

### 缺口

当前的 `targetHash` 用于偏移恢复（定位漂移后的目标），但**不直接作为锚点标识符**。真正的"哈希锚点"意味着:
- 不依赖 `startOffset/endOffset` 定位，而是用 `contentHash` 直接定位内容
- 标注锚点格式: `%%markvault:hash:uuid%%` → 哪怕文件大幅编辑，hash 仍能定位

### 评估

当前 4 层恢复机制（偏移→指纹搜索→上下文→兜底）已足够稳健，哈希锚点的额外价值有限。建议延后到 Phase III。

---

## C-2 快照历史 (5h) — 低优先级

### 现有基础

搜索索引已有 snapshot 导入/导出机制 (`SearchEngine.importIndex/exportIndex`)。

### 缺口

标注版本快照完全未实现。需要:
- `AnnotationSnapshot` 数据模型
- 每次标注变更时自动保存快照
- Undo/Redo 栈
- Diff UI（对比两个版本的标注内容）

### 评估

UI 改动大、风险高，建议延后到 Phase III-A 或更后。

---

## 实施顺序建议

```
本周: C-3 (3h) → C-4 (3h)
下周: (可选) C-1 或 Phase I 架构瘦身
```

总计 6h 工作量，预计 1-2 天完成。