# MarkVault「粗体标注」Native 架构分析

> 分析时间：2026-06-13  
> 分析范围：当前 `master` 工作区中的粗体标注实现（Bold 试验田）  
> 目标：说明为什么粗体采用「隐身锚点 + 可见 `<b>` 包裹」、数据如何流动、各模块如何协作，以及后续扩展方向。

---

## 1. 核心设计一句话

**粗体标注在 Markdown 中存为两段式结构：**

```markdown
%%mv:i:<uuid>:bold:<color>%%<b class="markvault-native markvault-bold markvault-<color> markvault-clickable" data-uuid="<uuid>" data-type="bold" data-color="<color>">文本</b>
```

- **隐身锚点 `%%mv:i:...%%`**：只存 `uuid / type / color`，是 Store 与 Markdown 之间的同步键。
- **可见 `<b>...</b>` 包裹**：在阅读模式直接渲染成带 `data-uuid` 的 DOM 元素，让跳转、点击、样式立即生效。
- **元数据 `note / tags / fields`**：不写入 Markdown，只保存在 `AnnotationStore` 分片 JSON 中。

---

## 2. 为什么这样设计？

| 需求 | 旧 `<mark data-uuid>` 方案 | 纯原生 `**文本**` | 新 native bold（锚点 + `<b>`） |
|------|---------------------------|------------------|------------------------------|
| 阅读模式跳转 | `<mark>` 能被命中，但 bold 需额外加粗样式 | 渲染成 `<strong>`，没有唯一标识，无法 `querySelector('[data-uuid]')` | `<b data-uuid>` 直接命中，稳定可靠 |
| 点击编辑 | 可以 | 无法区分普通加粗和标注加粗 | `.markvault-native` + `data-uuid` 精确识别 |
| 颜色调整 | 需内联 style 或复杂 class 处理 | 原生 `**` 无法携带颜色 | `<b class="markvault-<color>">` + CSS 即可 |
| 编辑稳定性 | 自定义 `<mark>` 在 CM6 中需要隐藏开闭标签，嵌套/重叠时易损坏 | 不携带元数据 | 锚点和 `<b>` 标签被隐藏后，内部仍是普通可编辑文本 |
| 与 Markdown 语法冲突 | `<mark>` 可能嵌套在 `**` / `==` 中导致结构损坏 | 元数据缺失 | 直接用 `<b>`，不再与 `**` 冲突 |

结论：`<b>` 包裹让粗体在阅读模式成为一个**可立即定位、可样式化、可交互的 DOM 元素**，同时通过隐身锚点保留了与 Store 的关联。

---

## 3. 数据流（从创建到渲染）

```
用户选中文字 → 创建 Annotation
                │
                ▼
        ┌──────────────────┐
        │  buildNativeAnnotation  │  ← 生成 anchor + <b> 包裹
        │  src/core/native-annotation.ts  │
        └──────────────────┘
                │
                ▼
        Markdown 文件写入
                │
                ▼
        ┌──────────────────────────────────┐
        │ parseNativeAnnotations / syncFromMarkdown │  ← 回读时识别 format='native'
        │ src/core/native-annotation.ts / markdown-sync.ts  │
        └──────────────────────────────────┘
                │
                ▼
        AnnotationStore 保存 { uuid, type, color, format: 'native', ... }
                │
    ┌───────────┴───────────┐
    ▼                       ▼
编辑模式 (CM6)             阅读模式 (Preview)
highlight-applier.ts       processNativeAnnotations + CSS
隐藏 anchor 与 <b> 标签      <b> 直接渲染
只给内部文本加 class        加 class / data-uuid / clickable
```

---

## 4. 各模块职责与关键代码

### 4.1 创建：为什么 Bold 强制走 native？

**`src/ui/editor/context-menu.ts`**

```ts
format: (plugin.settings.useNativeSyntax || type === 'bold') ? 'native' : 'mark',
```

即使用户没开 `useNativeSyntax`，`type === 'bold'` 也会强制 `format = 'native'`。

**`src/main.ts` 阅读模式创建**

```ts
} else if (this.settings.useNativeSyntax || type === 'bold') {
  format = 'native';
  const nativeTag = buildNativeAnnotation(annotation);
  // 写入源文件
}
```

### 4.2 构建：`buildNativeAnnotation`

**`src/core/native-annotation.ts`**

```ts
export function buildNativeAnnotation(annotation: Pick<Annotation, 'uuid' | 'type' | 'color' | 'text'>): string {
  const anchor = buildNativeAnchor(annotation.uuid, annotation.type, annotation.color);
  const wrapper = getNativeWrapper(annotation.type);
  if (annotation.type === 'bold') {
    return `${anchor}<b class="markvault-native markvault-bold markvault-${annotation.color} markvault-clickable" data-uuid="${annotation.uuid}" data-type="bold" data-color="${annotation.color}">${annotation.text}</b>`;
  }
  return `${anchor}${wrapper.open}${annotation.text}${wrapper.close}`;
}
```

非 bold 类型仍使用 `==文本==` 或 `<u>文本</u>`。

### 4.3 解析：`parseNativeAnnotations` / `findNativeWrapper`

**`src/core/native-annotation.ts`**

```ts
export const NATIVE_ANCHOR_REGEX = /%%mv:i:([^:%]+):([^:%]+):([^:%]+)%%/g;
```

解析后固定写入：

```ts
format: 'native',
```

Bold 的 wrapper 识别使用专用正则：

```ts
/^<b\s+class="markvault-native\s+markvault-bold\s+markvault-([^"\s]+)(?:\s+markvault-clickable)?"\s+data-uuid="([^"]+)"\s+data-type="bold"\s+data-color="([^"]+)">([^<]*)<\/b>/
```

### 4.4 编辑模式渲染：`highlight-applier.ts`

```ts
const NATIVE_BOLD_B_REGEX = /%%mv:i:([^:%]+):bold:([^:%]+)%%<b\s+class="markvault-native\s+markvault-bold\s+markvault-([^"\s]+)(?:\s+markvault-clickable)?"\s+data-uuid="[^"]+"\s+data-type="bold"\s+data-color="[^"]+">([^<]*)<\/b>/g;
```

装饰逻辑：

| 范围 | 装饰方式 | 效果 |
|------|----------|------|
| 锚点 `%%...%%` | `Decoration.replace` + `NativeAnchorWidget` | 隐藏 |
| `<b class="...">` | `Decoration.replace` | 隐藏 |
| 内部文本 | `Decoration.mark` + `class="markvault-bold markvault-<color>"` | 显示为粗体 + 彩色下划线 |
| `</b>` | `Decoration.replace` | 隐藏 |

### 4.5 阅读模式处理：`processNativeAnnotations`

**`src/main.ts`**

现在 `<b>` 已经是可见元素，`processNativeAnnotations` 只需：

1. 通过 comment 节点找到隐身锚点；
2. 给相邻的 `<b>` 元素添加 `.markvault-native`、`.markvault-<color>`、`.markvault-clickable`；
3. 设置 `dataset.uuid / type / color`。

对于 bold 不设置内联样式，完全交给 CSS。

### 4.6 点击与跳转

**阅读模式点击**

**`src/ui/reading/ReadingModeClickDelegate.ts`**

```ts
if (el.hasClass?.('markvault-native') && el.hasAttribute('data-uuid')) {
  foundMark = el;
}
```

**侧边栏跳转**

**`src/ui/sidebar/AnnotationSidebar.ts`**

```ts
if (view.getMode() === 'preview') {
  await this.scrollToPreviewAnnotation(view, annotation.uuid); // querySelector('[data-uuid="..."]')
}
```

源码模式则搜索 `mv:i:${uuid}`。

### 4.7 更新与删除

**`src/core/native-annotation.ts`**

- `updateNativeAnnotation`：定位旧锚点 + `<b>` 包裹，用 `buildNativeAnnotation` 重新生成后整体替换。
- `removeNativeAnnotation`：从后往前扫描锚点，连同 `<b>...</b>` 一起删除，只保留内部文本。

调用方：

- `AnnotationModal.save/remove`
- `AnnotationCard.quickChangeColor`
- `AnnotationSidebar.deleteAnnotationWithConfirm`

统一判断条件：`annotation.format === 'native'`。

---

## 5. 样式体系

**`styles.css`**

```css
.markvault-bold.markvault-yellow { font-weight: bold; border-bottom: 2px solid #FACC15; padding: 1px 0; }
.markvault-bold.markvault-green  { font-weight: bold; border-bottom: 2px solid #4ADE80; padding: 1px 0; }
.markvault-bold.markvault-blue   { font-weight: bold; border-bottom: 2px solid #60A5FA; padding: 1px 0; }
.markvault-bold.markvault-pink   { font-weight: bold; border-bottom: 2px solid #F472B6; padding: 1px 0; }
.markvault-bold.markvault-purple { font-weight: bold; border-bottom: 2px solid #C084FC; padding: 1px 0; }
```

- 编辑模式和阅读模式共用同一套 class。
- 不使用内联 style，方便用户主题覆盖。

---

## 6. 当前局限

| 局限 | 说明 |
|------|------|
| **仅 bold 完整落地** | Highlight / Underline 仍走 `==` / `<u>` 或 `<mark>`，未统一为可见包裹。 |
| **`<b>` 内容限制** | 当前正则 `([^<]*)` 不支持内部含 `<` 或换行。 |
| **源文本可见 raw HTML** | 在 Source 模式或外部编辑器中，`<b class="markvault-...">` 会原样显示。 |
| **与旧版 `**bold**` 共存** | 旧格式 `%%mv:i:...%%**文本**` 仍被兼容识别，可能导致同一 uuid 两种渲染。 |
| **offset-tracker 竞态** | 读 annotations 到执行 update 之间若被并发删除，仍会报 `Annotation not found`，需要更稳妥方案。 |

---

## 7. 扩展到 Highlight / Underline 的思路

### 7.1 源格式

`getNativeWrapper` 已定义：

```ts
case 'underline':
  return { open: '<u>', close: '</u>', tag: 'u' };
case 'highlight':
default:
  return { open: '==', close: '==' };
```

扩展后源格式：

```markdown
%%mv:i:<uuid>:highlight:<color>%%==文本==
%%mv:i:<uuid>:underline:<color>%%<u>文本</u>
```

### 7.2 CM6 装饰调整

当前只有 `NATIVE_BOLD_B_REGEX` 专门处理 `<b>`。要为 highlight/underline 补充：

| 类型 | 匹配模式 | 装饰行为 |
|------|----------|----------|
| highlight | `%%mv:i:<uuid>:highlight:<color>%%==文本==` | 隐藏锚点和 `==`，内部文本加 `markvault-highlight markvault-<color>` |
| underline | `%%mv:i:<uuid>:underline:<color>%%<u>文本</u>` | 隐藏锚点和 `<u>` 标签，内部文本加 `markvault-underline markvault-<color>` |

实现建议：复用 `findNativeWrapper` 基于 `NATIVE_ANCHOR_REGEX` 计算范围，避免维护多个大正则。

### 7.3 CSS 复用

`styles.css` 已定义 `.markvault-highlight.markvault-<color>` 和 `.markvault-underline.markvault-<color>`，扩展后无需新增 CSS。

---

## 8. 结论

当前粗体标注采用「**隐身锚点 + 可见 `<b>` 包裹**」的双层结构：

- **锚点负责身份与同步**：让 Markdown 与 Store 之间有一一对应的键。
- **`<b>` 包裹负责阅读模式交互**：提供可立即命中的 DOM 锚点、可点击事件、可样式化 class。
- **CM6 装饰负责编辑模式体验**：隐藏锚点和标签，只把内部文本渲染成带颜色下划线的粗体。
- **CSS 负责最终视觉**：避免内联样式，便于主题覆盖。

该设计主要解决了旧 `<mark>` 在编辑、嵌套、可编辑性上的脆弱性，同时比纯原生 `**` 提供了更可靠的阅读模式交互锚点。目前唯一完整落地的类型是 `bold`，`highlight`/`underline` 的 native 扩展在源格式和 CSS 上已具备条件，主要剩余工作是为 CM6 编辑模式补充对应的装饰识别逻辑。
