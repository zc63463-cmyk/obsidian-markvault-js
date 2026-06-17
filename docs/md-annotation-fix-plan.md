# MD 标注系统深度修复方案

> 日期: 2026-06-17 | 基于 md-annotation-deep-audit.md 40 项问题 | 5 批递进修复
> 状态: **规划阶段** — 待确认后进入实施

---

## 修复原则

1. **每批独立可验证** — 每批修复后必须全量测试通过 + esbuild 构建 + 部署验证
2. **先数据后体验** — P0 数据正确性优先于渲染一致性，先修 updatedAt / 偏移修正，再修 UI
3. **不引入新格式** — 双锚点/region 加 alias 段需格式版本升级，单独一批
4. **向后兼容** — 所有修改必须兼容已有数据，迁移脚本兜底

---

## 第一批：P0 数据正确性（5项，预计 3h）

> 目标：修复数据层面的硬伤，确保标注数据本身是正确的

### 1.1 P0-9: updateAnnotation 不更新 updatedAt

**问题**: `updateAnnotation` 及 5 个辅助方法修改标注后不更新 `updatedAt`，导致排序/统计/W3C 导出全部错误。

**修复方案**:

**文件**: `src/db/annotation-store.ts`

**变更 A**: `updateAnnotation` 方法（第 255 行）
```typescript
// 在 filteredChanges 构建后、合并前，自动注入 updatedAt
async updateAnnotation(uuid: string, changes: Partial<Annotation>): Promise<void> {
  // ... 原有校验 ...
  
  // 自动更新 updatedAt（除非调用方显式指定）
  if (changes.updatedAt === undefined) {
    (filteredChanges as Record<string, unknown>)['updatedAt'] = Date.now();
  }
  
  // 合并变更
  const newAnn: Annotation = stripExtraFields({ ...oldAnn, ...filteredChanges });
  // ...
}
```

**变更 B**: 5 个辅助方法，在 `removeFromIndex` 后、数据修改前加入 `updatedAt` 更新：
```typescript
// addTagToAnnotation (第 429-430 行之间)
ann.updatedAt = Date.now();

// removeTagFromAnnotation (第 447-448 行之间)
ann.updatedAt = Date.now();

// updateFlags (第 462-463 行之间)
ann.updatedAt = Date.now();

// addGroupToAnnotation (第 479-483 行之间)
ann.updatedAt = Date.now();

// removeGroupFromAnnotation (第 498-499 行之间)
ann.updatedAt = Date.now();
```

**风险**: 极低。纯追加 `updatedAt` 赋值，不影响任何现有逻辑。唯一注意：`applyIncrementalOffsetFix` 调用 `updateAnnotation` 时注释说"不更新 updatedAt"——此时 `changes` 中不含 `updatedAt`，会被自动注入。这是**正确行为**（偏移修正也是修改），如确需区分可在 `changes` 中显式传 `updatedAt: oldAnn.updatedAt` 保持原值。

**测试**: 新增 `updatedAt-auto-update.test.ts`，验证：
- updateAnnotation 后 updatedAt > 旧值
- addTag/removeTag/updateFlags/addGroup/removeGroup 后 updatedAt > 旧值
- 连续操作 updatedAt 单调递增

---

### 1.2 P0-1: forceSyncFile 恢复失败无通知

**问题**: block/span/region 恢复失败仅 `failed++`，不通知用户，不标记标注状态。

**修复方案**:

**文件**: `src/plugin/sync-engine.ts`

**变更 A**: 收集失败标注 UUID 和原因（第 186/210/257/298/319/336 行）
```typescript
// 在 forceSyncFile 方法开头增加
const failedDetails: Array<{ uuid: string; reason: string }> = [];

// 每个 failed++ 位置替换为：
failedDetails.push({ uuid: ann.uuid, reason: 'block_anchor_missing' });
// failed++ (保留计数器)
```

**变更 B**: 方法末尾发送 Notice（第 369 行前）
```typescript
if (failedDetails.length > 0) {
  // 标记恢复失败的标注
  for (const detail of failedDetails) {
    const ann = await annotationStore.getAnnotation(detail.uuid);
    if (ann) {
      await annotationStore.updateAnnotation(detail.uuid, {
        flags: { ...ann.flags, needsCorrection: true },
      });
    }
  }
  new Notice(`⚠️ ${failedDetails.length} 个标注恢复失败，已标记为需修正`, 5000);
}

if (inlineRecovered + blocksRecovered + spansRecovered > 0) {
  new Notice(`✅ 已恢复 ${inlineRecovered + blocksRecovered + spansRecovered} 个标注位置`, 3000);
}
```

**风险**: 低。新增 Notice 不影响核心逻辑，`needsCorrection` 标记为增量合并。

**测试**: 新增 `sync-recovery-notice.test.ts`，验证：
- 恢复失败时 failedDetails 有记录
- needsCorrection 被正确设置

---

### 1.3 P0-3: span 偏移修正遗漏 [fromA, toA) 区间

**问题**: inline/block 标注尾部落在变更删除区间 `[fromA, toA)` 时，偏移修正公式错误。

**修复方案**:

**文件**: `src/core/offset-tracker.ts`

**变更 A**: inline/block 标注偏移修正（第 197-218 行），重构为 5 种情况：
```typescript
// 情况 3: 变更与标注重叠 — 细分为 5 子情况
const annStartBeforeChange = ann.startOffset < change.fromA;
const annStartInChange = ann.startOffset >= change.fromA && ann.startOffset < change.toA;
const annEndInChange = ann.endOffset > change.fromA && ann.endOffset <= change.toA;
const annEndAfterChange = ann.endOffset > change.toA;

// 3a: 标注完全被变更包含 (start 在变更内, end 在变更内)
if (annStartInChange && annEndInChange) {
  // 标注完全在删除范围内 → 删除
  toDelete.push(ann.uuid);
  continue;
}

// 3b: 标注尾部被变更覆盖 (start 在变更前, end 在 [fromA, toA])
if (annStartBeforeChange && annEndInChange) {
  // end 收缩到 fromA（删除区间起点）
  const newEnd = change.fromA;
  if (newEnd > ann.startOffset) {
    toUpdate.push({ uuid: ann.uuid, startOffset: ann.startOffset, endOffset: newEnd });
    ann.endOffset = newEnd;
  } else {
    toDelete.push(ann.uuid);
  }
  continue;
}

// 3c: 标注跨越整个变更 (start 在变更前, end 在变更后)
if (annStartBeforeChange && annEndAfterChange) {
  // end 平移 delta（因为 [fromA, toA) 被替换为 [fromA, fromA+insertedLen)）
  const newEnd = ann.endOffset + change.delta;
  toUpdate.push({ uuid: ann.uuid, startOffset: ann.startOffset, endOffset: newEnd });
  ann.endOffset = newEnd;
  continue;
}

// 3d: 标注起始在变更内, end 在变更后
if (annStartInChange && annEndAfterChange) {
  // start 移到 fromA, end 平移 delta
  const newStart = change.fromA;
  const newEnd = ann.endOffset + change.delta;
  if (newEnd > newStart) {
    toUpdate.push({ uuid: ann.uuid, startOffset: newStart, endOffset: newEnd });
    ann.startOffset = newStart;
    ann.endOffset = newEnd;
  } else {
    toDelete.push(ann.uuid);
  }
  continue;
}

// 3e: 标注完全包含变更 (start < fromA, end > toA) — 等价于 3c，已处理
// 保留原有的 >50% 删除检查作为安全兜底
```

**变更 B**: span range 偏移修正（第 139-144 行），同样细化区间处理：
```typescript
// range.from 在变更前, range.to 在 [fromA, toA) 区间
if (range.from < change.fromA && range.to > change.fromA && range.to <= change.toA) {
  // range.to 收缩到 fromA（保留变更前的部分）
  const newTo = change.fromA;
  if (newTo > range.from) {
    newRanges.push({ from: range.from, to: newTo });
    allDeleted = false;
  }
  rangesModified = true;
  continue;
}
```

**风险**: 中等。偏移修正是核心逻辑，需严格测试。建议先写测试用例覆盖所有 5 种子情况，再改代码。

**测试**: 扩展 `offset-tracker.test.ts`，新增：
- 标注尾部落在 [fromA, toA) — end 收缩
- 标注完全被包含在 [fromA, toA) — 标注删除
- 标注跨越变更 — end 平移
- range.to 在 [fromA, toA) — range 收缩
- 纯插入（delta > 0, deletedLen = 0）— 所有区间正常

---

### 1.4 P0-4: findSpanLineBySignature 单行 vs 多行

**问题**: `findSpanLineBySignature` 逐行计算单行指纹与多行 `targetHash` 比较，数学上永远不匹配。

**修复方案**:

**文件**: `src/core/block-fingerprint.ts`

**变更 A**: 重写 `findSpanLineBySignature`（第 178-208 行）为多行累积指纹搜索：
```typescript
export function findSpanLineBySignature(
  lines: string[],
  signature: string,
  preferredLine: number,
  searchWindow: number = SIGNATURE_WINDOW,
): number | null {
  if (!signature) return null;

  let bestLine: number | null = null;
  let bestDist = Infinity;

  const start = Math.max(0, preferredLine - searchWindow);
  const end = Math.min(lines.length - 1, preferredLine + searchWindow);

  // 从每个候选起始行开始，累积多行文本计算指纹
  for (let i = start; i <= end; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    if (/^%%markvault(-span)?:/.test(line)) continue;

    // 从此行开始累积文本，最多尝试 20 行
    let accumulated = '';
    for (let j = i; j < Math.min(lines.length, i + 20); j++) {
      const trimmed = lines[j].trim();
      if (/^%%markvault(-span)?:/.test(trimmed)) break;
      if (trimmed.length === 0 && accumulated.length > 0) {
        accumulated += ' ';
        continue;
      }
      accumulated += (accumulated ? ' ' : '') + trimmed;

      const candidateSig = computeSpanSignature(accumulated);
      if (candidateSig === signature) {
        const dist = Math.abs(i - preferredLine);
        if (dist < bestDist) {
          bestDist = dist;
          bestLine = i;
        }
        break; // 找到匹配，无需继续累积
      }
    }
  }

  return bestLine;
}
```

**风险**: 中等。最坏情况搜索复杂度从 O(n) 变为 O(n×20)，但 `searchWindow=30` 和 `最多20行累积` 使实际为 O(600)，完全可接受。

**测试**: 新增 `span-signature-search.test.ts`，验证：
- 单行 span 指纹搜索
- 多行 span 指纹搜索（核心修复点）
- span 在 preferredLine 偏移 ±10 行
- 空行/锚点行正确跳过

---

### 1.5 P0-5: block 创建时 contextBefore/contextAfter 为空

**问题**: 编辑模式 `createBlockAnnotation` 硬编码 `contextBefore: ''` 和 `contextAfter: ''`。

**修复方案**:

**文件**: `src/ui/editor/context-menu.ts`

**变更 A**: 在 `createBlockAnnotation` 方法（约第 740 行）提取上下文信息：
```typescript
// 在 buildAnnotation 调用前，从编辑器提取上下文
const content = editor.getValue();
const blockStartOffset = editor.posToOffset({ line: blockInfo.startLine, ch: 0 });
const blockEndOffset = editor.posToOffset({ line: blockInfo.endLine + 1, ch: 0 });

const contextBefore = content.substring(Math.max(0, blockStartOffset - 80), blockStartOffset);
const contextAfter = content.substring(
  Math.min(content.length, blockEndOffset),
  Math.min(content.length, blockEndOffset + 80),
);

// 然后在 buildAnnotation 中使用:
contextBefore,
contextAfter,
```

**风险**: 低。仅补全缺失字段，与阅读模式 `annotation-creator.ts:124-125` 保持一致。

**测试**: 手动验证。在编辑模式下创建 block 标注，检查 annotation 对象的 contextBefore/contextAfter 非空。

---

## 第二批：P0 跳转与渲染（3项，预计 4h）

> 目标：修复跳转准确性和渲染正确性

### 2.1 P0-2: 跳转用 vault.read() 而非编辑器值

**问题**: `jumpToAnnotation` 用 `vault.read(file)` 读取磁盘内容，编辑器可能有未保存修改。

**修复方案**:

**文件**: `src/ui/sidebar/AnnotationSidebar.ts`

**变更 A**: 第 491 行，优先使用编辑器实时内容：
```typescript
// 优先使用编辑器实时内容，避免 vault.read 缓存问题
const editor = (view as MarkdownView).editor;
const content = editor ? editor.getValue() : await this.app.vault.read(file);
```

**变更 B**: 跳转目标定位也改用编辑器偏移（第 513-530 行）：
```typescript
if (editor && 'offsetToPos' in editor) {
  // CM6 编辑器可直接用偏移定位
  const idx = content.indexOf(searchStr);
  if (idx !== -1) {
    const pos = editor.offsetToPos(idx);
    editor.setCursor(pos);
    editor.scrollIntoView(
      { from: pos, to: { line: pos.line + 1, ch: 0 } },
      true,
    );
    return;
  }
}
// 降级：原有行号搜索逻辑
```

**风险**: 低。`editor.getValue()` 与 `vault.read()` 返回相同格式（纯文本），只是内容时效性更好。

**测试**: 手动验证。编辑文件不保存，点击侧边栏标注跳转，确认定位到正确位置。

---

### 2.2 P0-7: 代码块内 inline 标注渲染异常

**问题**: `<mark>` 和 native 锚点在 CM6 代码块 Widget 内被错误渲染，阅读模式下 `<mark>` 在 `<code>` 内被转义。

**修复方案**:

**文件**: `src/core/highlight-applier.ts`

**变更 A**: 在 `buildDecorationsInner` 中增加代码块范围检测，跳过代码块内的标注装饰：
```typescript
// 在 buildDecorationsInner 方法开头，预扫描代码块范围
const codeBlockRanges: Array<{ from: number; to: number }> = [];
let inCodeBlock = false;
let codeBlockStart = 0;
for (let i = 0; i < doc.lines; i++) {
  const line = doc.line(i + 1);
  if (/^```/.test(line.text.trim())) {
    if (!inCodeBlock) {
      inCodeBlock = true;
      codeBlockStart = line.from;
    } else {
      codeBlockRanges.push({ from: codeBlockStart, to: line.to });
      inCodeBlock = false;
    }
  }
}
// 行内代码 `...` 也标记
// ... (简化：可用正则扫描)

// 在每个 decoration 创建前检查是否在代码块范围内
function isInCodeBlock(from: number, to: number): boolean {
  return codeBlockRanges.some(r => from >= r.from && to <= r.to);
}
```

**变更 B**: 跳过代码块内的 mark/native/span 装饰创建：
```typescript
// 在 mark 装饰循环中（第 451 行附近）
if (isInCodeBlock(mark.openFrom, mark.closeTo)) continue;

// 在 native 装饰循环中（第 565 行附近）
if (isInCodeBlock(native.startOffset, native.endOffset)) continue;

// 在 span 装饰循环中（第 468 行附近）
if (isInCodeBlock(spanRange.from, spanRange.to)) continue;
```

**文件**: `src/plugin/reading-processor.ts`

**变更 C**: 阅读模式下检测 `<mark>` 是否在 `<code>` 或 `<pre>` 内，如果是则跳过渲染或改用纯文本标记：
```typescript
// 在 markTag 替换逻辑中
const parentCode = markEl.closest('code, pre');
if (parentCode) {
  // 代码块内：保留文本内容，移除 <mark> 标签但添加下划线样式
  markEl.replaceWith(markEl.textContent || '');
  // 或者：给父 <code> 添加 data-uuid 属性，用 CSS 下划线指示
}
```

**风险**: 中等。代码块范围检测需要考虑嵌套（markdown 中的缩进代码块）和行内代码（\`code\`）。建议先只处理围栏代码块（\`\`\`），行内代码后续处理。

**测试**: 新增 `code-block-annotation.test.ts`，验证：
- 围栏代码块内的 `<mark>` 不生成装饰
- 围栏代码块外的 `<mark>` 正常渲染
- 阅读模式下代码块内标注不破坏 HTML 结构

---

### 2.3 P0-8: inline 标注重叠编辑模式只显示第一个

**问题**: `filterOverlapping` 直接丢弃重叠标注，而非部分渲染或合并。

**修复方案**:

**文件**: `src/core/highlight-applier.ts`

**变更 A**: 修改 `filterOverlapping`（第 862-885 行）为保留所有标注但标记重叠：
```typescript
private filterOverlapping(marks: Array<...>): Array<...> {
  if (marks.length <= 1) return marks;

  // 按起始位置排序
  marks.sort((a, b) => a.openFrom - b.openFrom);

  // 不再丢弃重叠标注，而是标记重叠关系
  // CM6 Decoration.mark 支持同一范围多个 class
  // 重叠标注通过不同 opacity 区分
  const result: Array<...> = [];
  const activeRanges: Array<{ closeTo: number; idx: number }> = [];

  for (let i = 0; i < marks.length; i++) {
    // 清理已结束的活跃范围
    const mark = marks[i];

    // 检查当前标注与哪些活跃范围重叠
    const overlappingCount = activeRanges.filter(r => r.closeTo > mark.openFrom).length;

    // 保留标注，但通过 class 标记重叠层级
    if (overlappingCount > 0) {
      mark.overlapLevel = overlappingCount; // 新增字段
    }

    result.push(mark);
    activeRanges.push({ closeTo: mark.closeTo, idx: i });
  }

  return result;
}
```

**变更 B**: 在 decoration 创建时使用 opacity 区分重叠标注：
```typescript
// 在创建 inline decoration 时
const opacityClass = mark.overlapLevel > 0 ? ` mv-overlap-${mark.overlapLevel}` : '';
const className = `markvault-highlight markvault-${mark.type}${opacityClass}`;
```

**变更 C**: 在 `styles.css` 中添加重叠样式：
```css
.markvault-highlight.mv-overlap-1 { opacity: 0.75; }
.markvault-highlight.mv-overlap-2 { opacity: 0.6; }
.markvault-highlight.mv-overlap-3 { opacity: 0.45; }
```

**风险**: 中低。主要变更在 UI 层，不影响数据。需要注意：CM6 `Decoration.mark` 在重叠范围时可能合并 DOM 元素，需测试实际渲染效果。

**测试**: 手动验证。创建两个重叠的 inline 标注，确认编辑模式下两个都可见（不同透明度）。

---

## 第三批：P1 跳转定位 + 数据一致性（8项，预计 6h）

> 目标：修复跳转精确性和数据丢失问题

### 3.1 P1-3: 跳转到锚点而非内容

**文件**: `src/ui/sidebar/AnnotationSidebar.ts`

**修改**: block/span 跳转时定位到 `targetLine` 而非锚点行：
```typescript
// 在 jumpToAnnotation 中，block 类型搜索后偏移
if (annotation.kind === 'block' || annotation.kind === 'span') {
  const targetLine = annotation.targetLine ?? annotation.startLine;
  editor.setCursor({ line: targetLine, ch: 0 });
  editor.scrollIntoView(
    { from: { line: targetLine, ch: 0 }, to: { line: targetLine + 1, ch: 0 } },
    true,
  );
  return;
}
```

### 3.2 P1-5: RelationGraph 跳转不定位

**文件**: `src/ui/graph/RelationGraphView.ts`（约第 668-678 行）

**修改**: 复用 `AnnotationSidebar.jumpToAnnotation` 的完整逻辑：
```typescript
// 在节点双击处理中
const sidebar = this.app.workspace.getLeavesOfType('markvault-annotation-sidebar')[0]?.view;
if (sidebar && 'jumpToAnnotation' in sidebar) {
  (sidebar as any).jumpToAnnotation(annotation);
}
```

### 3.3 P1-7: 偏移修正不更新 contextBefore/contextAfter

**文件**: `src/core/offset-tracker.ts`

**修改**: 偏移修正时，如果 delta 超过阈值（如 10 字符），重新提取 context：
```typescript
// 在 toUpdate 推入前，检查是否需要更新 context
if (Math.abs(change.delta) > 10 && annotationStore) {
  // 获取当前文件内容
  const file = app.vault.getAbstractFileByPath(filePath);
  if (file instanceof TFile) {
    const content = await app.vault.read(file);
    const newContextBefore = content.substring(Math.max(0, u.startOffset - 80), u.startOffset);
    const newContextAfter = content.substring(u.endOffset, Math.min(content.length, u.endOffset + 80));
    updates.contextBefore = newContextBefore;
    updates.contextAfter = newContextAfter;
  }
}
```

**注意**: `offset-tracker.ts` 当前不依赖 `app` 实例，需要传入文件内容或回调函数。建议在 `applyIncrementalOffsetFix` 签名中增加可选的 `getContent` 回调。

### 3.4 P1-9: startLine=0 硬编码

**文件**: `src/plugin/annotation-creator.ts`（约第 200 行）

**修改**: 从 startOffset 计算正确行号：
```typescript
// 替换 startLine: 0
const startLine = content.substring(0, startOffset).split('\n').length - 1;
```

### 3.5 P1-10: span startLine 0-based/1-based 歧义

**文件**: `src/ui/editor/context-menu.ts`（约第 542 行）

**修改**: 统一为 0-based 行号，所有消费方确认使用 0-based。

### 3.6 P1-14: AnnotationCreateParams 缺少 fields/alias 等

**文件**: `src/plugin/annotation-creator.ts`

**修改**: 扩展 `AnnotationCreateParams` 和 `buildAnnotation`：
```typescript
export interface AnnotationCreateParams {
  // ... 原有字段 ...
  fields?: Record<string, string>;
  alias?: string;
  relations?: AnnotationRelation[];
  flags?: Partial<AnnotationFlag>;
  groups?: string[];
  motivation?: Annotation['motivation'];
  endLine?: number;
}
```

### 3.7 P1-15: migration.ts 遗漏 7 个字段

**文件**: `src/db/migration.ts`

**修改**: 补全遗漏字段：
```typescript
const annotation: Annotation = {
  // ... 原有字段 ...
  format: cleanAnn.format,
  relations: cleanAnn.relations,
  flags: cleanAnn.flags,
  groups: cleanAnn.groups,
  motivation: cleanAnn.motivation,
  alias: cleanAnn.alias,
  endLine: cleanAnn.endLine,
};
```

### 3.8 P1-6: applyIncrementalOffsetFix 排序与遍历方向

**文件**: `src/core/offset-tracker.ts`

**修改**: 变更从大到小排序后，标注也应按 startOffset 从大到小排序，确保从后往前处理：
```typescript
// 在 for (const ann of allAnnotations) 前
const sortedAnnotations = [...allAnnotations].sort((a, b) => b.startOffset - a.startOffset);
for (const ann of sortedAnnotations) {
```

**注意**: 原代码直接修改 `ann.startOffset/endOffset`（内存中），所以从后往前处理变更时不会干扰前面标注。但标注遍历顺序仍应保证一致性。

---

## 第四批：锚点格式升级 + alias 支持（3项，预计 5h）

> 目标：扩展双锚点/region 格式支持 alias，解决 Markdown round-trip 丢失问题
> ⚠️ 这是格式变更，需要向后兼容处理

### 4.1 P1-11: block 双锚点格式增加 alias 段

**文件**: `src/core/annotation-parser.ts`

**设计**:
- 旧格式: `%%markvault-block:uuid:type:color:start:note%%`（5段）
- 新格式: `%%markvault-block:uuid:type:color:alias:start:note%%`（6段，v2）

**正则**: 同时匹配旧 5 段和新 6 段格式：
```typescript
export const BLOCK_DOUBLE_ANCHOR_REGEX = /%%markvault-block:([^:%]+):([^:%]+):([^:%]+)(?::([^:%]*))?:((?:start|end)):([^%]*)%%/g;
```

**build**: 有 alias 时用 6 段，无 alias 时仍用 5 段（向后兼容）：
```typescript
export function buildBlockAnchorStart(annotation: {
  uuid: string; type: AnnotationType; color: string;
  alias?: string; note: string;
}): string {
  const aliasField = annotation.alias ? escapeBlockAnchorField(annotation.alias) : '_';
  return `%%markvault-block:${annotation.uuid}:${annotation.type}:${annotation.color}:${aliasField}:start:${escapeBlockAnchorField(annotation.note || '')}%%`;
}
```

**parse**: 兼容两种格式：
```typescript
// 如果第4段是 start/end，则是旧格式(5段)；否则是新格式(6段)
const positionField = aliasOrPosition; // 第4段
if (positionField === 'start' || positionField === 'end') {
  // 旧格式: uuid:type:color:position:note
  alias = undefined;
  position = positionField;
  note = noteOrAlias; // 第5段实际是 note
} else {
  // 新格式: uuid:type:color:alias:position:note
  alias = positionField === '_' ? undefined : unescapeBlockAnchorField(positionField);
  position = noteOrAlias as 'start' | 'end'; // 第5段是 position
  // note 是第6段
}
```

### 4.2 P1-12: region 锚点格式增加 alias 段

**文件**: `src/core/region-annotation.ts`

**设计**: 同理，从 5 段升级到 6 段：
- 旧: `%%markvault-region:uuid:type:color:position:note%%`
- 新: `%%markvault-region:uuid:type:color:alias:position:note%%`

**兼容策略**: 同 4.1

### 4.3 P1-13: updateRegionAnnotation 支持 alias 更新

**文件**: `src/core/region-annotation.ts`

**修改**: `updateRegionAnnotation` 方法增加 alias 参数传递到锚点重建。

---

## 第五批：P1 渲染一致性 + P2 清理（8项，预计 6h）

### 5.1 P1-17: 编辑模式点击标注

**文件**: `src/core/highlight-applier.ts`

**方案**: 
1. Widget 的 `ignoreEvent()` 改为返回 `false`
2. 注册全局 DOM 事件监听器，拦截点击 `data-uuid` 元素
3. 点击后触发侧边栏选中对应标注

```typescript
// 在 ViewPlugin 构造函数中
this.domEventHandler = view.dom.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const uuidEl = target.closest('[data-uuid]');
  if (uuidEl) {
    const uuid = uuidEl.getAttribute('data-uuid');
    if (uuid) {
      e.preventDefault();
      e.stopPropagation();
      // 通知插件选中此标注
      plugin.selectAnnotation(uuid);
    }
  }
});
```

### 5.2 P1-18: block 编辑模式徽章

**文件**: `src/core/highlight-applier.ts`

**方案**: 在 block 标注行添加 `Decoration.widget` 徽章（类似阅读模式的 block indicator）。

### 5.3 P1-19: region 视觉统一

**文件**: `src/core/highlight-applier.ts` + `styles.css`

**方案**: 统一编辑/阅读模式下 region 的视觉样式（背景色 + 左侧边框）。

### 5.4 P1-21: 大文件性能优化

**文件**: `src/core/highlight-applier.ts`

**方案**: 
1. 限制 `buildDecorationsInner` 只处理 `view.visibleRanges` 内的标注
2. 非可视范围的标注使用缓存 Decoration
3. debounce 快速连续输入（100ms）

```typescript
update(update: ViewUpdate) {
  if (update.docChanged) {
    // debounce: 100ms 内的连续变更只触发一次重建
    clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => {
      this.decorations = this.buildDecorations(update.view);
    }, 100);
    return;
  }
  if (update.viewportChanged) {
    this.decorations = this.buildDecorations(update.view);
  }
}
```

### 5.5 P1-2: region 锚点成对检查

**文件**: `src/plugin/sync-engine.ts`

**方案**: 在 region 恢复逻辑中检查 start/end 锚点是否成对存在。

### 5.6 P1-4: 跳转失败通知

**文件**: `src/ui/sidebar/AnnotationSidebar.ts`

**方案**: 阅读模式跳转失败时，显示 Notice 说明原因，不静默切换模式。

### 5.7 P1-20: 多 region 重叠 dataset.uuid 覆盖

**文件**: `src/plugin/reading-processor.ts`

**方案**: 多个 region 重叠时，使用 `data-uuids="uuid1,uuid2"` 存储多个 UUID。

### 5.8 P1-22: 双 leaf 缓存竞态

**文件**: `src/core/cache-manager.ts`

**方案**: 缓存键增加 `leafId` 区分不同 leaf 实例。

---

## P6: region startOffset 语义统一（设计专项）

**问题**: region 的 startOffset/endOffset 包含锚点文本长度，而 inline 不包含。

**这不是一个简单的 Bug，而是设计语义问题**。两种修复方向：

**方向 A: region startOffset 不包含锚点（与 inline 对齐）**
- 修改 region-annotation.ts 的 parseRegionAnnotations，startOffset 指向纯内容起始
- 需要修改 sync-engine.ts 的 region 恢复比较逻辑
- 需要修改 highlight-applier.ts 的 region layer 渲染范围
- 风险：现有 region 标注数据全部需要偏移修正

**方向 B: 文档化差异，保持现状（推荐）**
- 在代码注释和类型定义中明确标注 region 的 startOffset/endOffset 语义
- 在所有消费 region 偏移的地方加上 `// region offset includes anchors` 注释
- 新增 `contentStartOffset = startOffset + anchorLength` 辅助属性
- 风险：最低，不改数据

**建议**: 先走方向 B（0.5h），后续有时间再做方向 A 的迁移。

---

## 测试补齐计划

| 模块 | 当前状态 | 目标 | 新增测试 |
|------|---------|------|---------|
| offset-tracker | 无独立测试 | 覆盖 5 种偏移情况 | ~30 项 |
| sync-engine | 无独立测试 | 覆盖恢复通知/标记 | ~20 项 |
| annotation-creator | 无独立测试 | 覆盖 context/fields | ~15 项 |
| block-fingerprint | 有基础测试 | 覆盖多行 span 搜索 | ~15 项 |
| migration | 无独立测试 | 覆盖字段完整性 | ~10 项 |
| **合计** | 539 | **630+** | **~90 项** |

---

## 修复时间线总览

| 批次 | 内容 | 工时 | 依赖 |
|------|------|------|------|
| **第一批** | P0 数据正确性（5项） | 3h | 无 |
| **第二批** | P0 跳转与渲染（3项） | 4h | 第一批 |
| **第三批** | P1 跳转定位 + 数据一致性（8项） | 6h | 第一批 |
| **第四批** | 锚点格式升级 + alias（3项） | 5h | 第三批 |
| **第五批** | P1 渲染一致性 + P2 清理（8项） | 6h | 第二批 |
| **合计** | 27 项核心修复 | **24h** | — |

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 偏移修正重构引入新 Bug | 标注丢失 | 先写测试，再改代码；每步全量测试 |
| 锚点格式升级破坏旧数据 | 无法解析 | 解析器兼容新旧格式；构建器默认新格式 |
| 代码块检测误判 | 正常标注不渲染 | 先只处理围栏代码块，行内代码后续 |
| 重叠标注渲染异常 | CM6 DOM 错误 | 充分测试重叠边界条件 |
| region 语义变更迁移 | 现有数据偏移错误 | 先走方向 B（不改数据），迁移留后续 |

---

## 未列入本轮的 P2 项（12项，延后处理）

| # | 问题 | 延后原因 |
|---|------|---------|
| P2-1 | djb2 → fnv1a/murmur3 | 当前数据量下碰撞风险可忽略 |
| P2-2 | 冷却期 30s 硬编码 | 功能正常，仅需配置化 |
| P2-3 | 50% 重叠阈值硬编码 | 功能正常，仅需配置化 |
| P2-4 | 代码块指纹基准不一致 | 影响有限 |
| P2-5 | inline 无 targetHash | 需设计决策，影响大 |
| P2-6 | IndexLayer 不索引 alias | 功能缺失但不影响现有使用 |
| P2-7 | W3C 外部导入行号丢失 | W3C 规范限制 |
| P2-8 | hideLeakedAnchorText 误匹配 | 边界场景 |
| P2-9 | 阅读模式 span 搜索含 MD 特殊字符 | 复杂度高 |
| P2-10 | 编辑模式无 tooltip | 体验优化 |
| P2-11 | region layer 覆盖范围含锚点 | 视觉细节 |
| P2-12 | Mark 解析 schemaVersion 兜底 | 语义问题 |

---

## 下一步行动

确认本方案后，建议按批次顺序执行：

1. ✅ 第一批 P0 数据正确性（3h）— 可立即开始
2. ✅ 第二批 P0 跳转与渲染（4h）— 第一批完成后
3. ✅ 第三批 P1 跳转定位 + 数据一致性（6h）
4. ✅ 第四批 锚点格式升级（5h）
5. ✅ 第五批 P1 渲染一致性（6h）

每批完成后：全量测试 → esbuild 构建 → 部署验证 → 提交
