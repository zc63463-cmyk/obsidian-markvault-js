/**
 * CM6 Decoration Plugin — 编辑模式实时高亮渲染
 *
 * 在 Obsidian 编辑模式（Source / Live Preview）下，
 * 使用 CodeMirror 6 的 ViewPlugin + Decoration API
 * 将 <mark data-uuid="..."> 标签渲染为可视化高亮。
 *
 * 策略：
 * 1. 解析编辑器文档中的 <mark ...>...</mark> 标签
 * 2. 对开标签 <mark ...> 和闭标签 </mark> 应用 Decoration.replace 隐藏
 * 3. 对内部文本应用 Decoration.mark（背景色/下划线/加粗）
 *
 * 注意：
 * - RangeSetBuilder 要求按位置递增顺序添加 decoration
 * - 所有解析操作包裹在 try-catch 中，防止崩溃
 * - Obsidian 内部提供 @codemirror/state 和 @codemirror/view，无需安装
 */

import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  type PluginSpec,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { PRESET_COLORS, type AnnotationType, type SpanRange } from '../types/annotation';

// ─── 外部注入的文件路径解析器 ──────────────────────────────

/**
 * 由 main.ts 注入的文件路径解析函数
 * 优先使用 Obsidian API（app.workspace.getActiveFile），
 * DOM 属性作为备用方案
 */
let filePathResolver: (() => string | null) | null = null;

/** 注入文件路径解析器（在 main.ts onload 中调用） */
export function setFilePathResolver(resolver: () => string | null): void {
  filePathResolver = resolver;
}

/** 获取当前活跃文件路径 */
function resolveFilePath(): string | null {
  if (filePathResolver) {
    try {
      return filePathResolver();
    } catch {
      // fallback to DOM
    }
  }
  return null;
}

// ─── Regex Patterns ──────────────────────────────────────

/** 匹配完整的 <mark ...>text</mark> */
const MARK_FULL_REGEX = /<mark\s+([^>]*)>([\s\S]*?)<\/mark>/g;
/** 从属性字符串中提取属性 */
const ATTR_EXTRACT_REGEX = /\b([\w-]+)="([^"]*)"/g;
/** 匹配 %%markvault:%% 锚点行（note 段可选） */
const BLOCK_ANCHOR_REGEX = /%%markvault(?:-span)?:[^:%]+:[^:%]+:[^:%]+(?::[^%]*)?%%/g;

// ─── Span Annotation Cache ──────────────────────────────────

/** Span 标注缓存数据（从 DB 加载） */
export interface SpanAnnotationData {
  uuid: string;
  type: AnnotationType;
  color: string;
  anchorLine: number;
  spanRanges: SpanRange[];
  note: string;
}

/**
 * 全局 span 标注缓存，按文件路径索引
 * 在 main.ts 的 updateSpanCache() 中更新
 * MarkVaultDecorator 构建装饰时从此缓存读取
 */
const spanCache = new Map<string, SpanAnnotationData[]>();

/** 更新指定文件的 span 标注缓存 */
export function updateSpanCacheForFile(filePath: string, annotations: SpanAnnotationData[]): void {
  if (annotations.length > 0) {
    spanCache.set(filePath, annotations);
  } else {
    spanCache.delete(filePath);
  }
}

/** 获取指定文件的 span 标注缓存 */
export function getSpanCacheForFile(filePath: string): SpanAnnotationData[] {
  return spanCache.get(filePath) || [];
}

/** 清除指定文件的 span 标注缓存 */
export function clearSpanCacheForFile(filePath: string): void {
  spanCache.delete(filePath);
}

/** 清除所有 span 缓存 */
export function clearSpanCache(): void {
  spanCache.clear();
}

// ─── Widget Types ────────────────────────────────────────

/**
 * 隐藏 <mark> 开标签的 Widget
 * 将 <mark data-uuid="..." ...> 替换为一个不可见的 span
 */
class MarkOpenWidget extends WidgetType {
  constructor(
    readonly uuid: string,
    readonly type: AnnotationType,
    readonly color: string,
    readonly note: string,
  ) {
    super();
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'markvault-mark-open';
    span.dataset.uuid = this.uuid;
    span.dataset.type = this.type;
    span.dataset.color = this.color;
    if (this.note) {
      span.title = this.note;
    }
    span.style.display = 'none';
    return span;
  }

  ignoreEvent() {
    return true;
  }
}

/**
 * 隐藏 </mark> 闭标签的 Widget
 */
class MarkCloseWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.className = 'markvault-mark-close';
    span.style.display = 'none';
    return span;
  }

  ignoreEvent() {
    return true;
  }
}

/**
 * 隐藏 %%markvault:%% 锚点行的 Widget
 * 将锚点行替换为一个不可见的 span，保持锚点行占位但不可见
 */
class BlockAnchorWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.className = 'markvault-block-anchor-hidden';
    span.style.display = 'none';
    return span;
  }

  ignoreEvent() {
    return true;
  }
}

// ─── ViewPlugin 实现 ─────────────────────────────────────

class MarkVaultDecorator implements PluginValue {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = this.buildDecorations(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.buildDecorations(update.view);
    }
  }

  destroy() {
    // cleanup
  }

  private buildDecorations(view: EditorView): DecorationSet {
    try {
      return this.buildDecorationsInner(view);
    } catch (err) {
      // 如果构建失败，返回空 DecorationSet，不能让整个 CM6 崩溃
      console.error('MarkVault: buildDecorations error', err);
      return Decoration.none;
    }
  }

  /**
   * 从 CM6 view 推断当前文件路径
   * 通过 Obsidian 的 DOM 结构查找 .workspace-leaf 的 data-path 属性
   */
  private getFilePathFromView(view: EditorView): string | null {
    try {
      const dom = view.dom;
      const leafEl = dom.closest('.workspace-leaf');
      if (leafEl) {
        // Obsidian 在 .workspace-leaf-content 上存储文件路径
        const contentEl = leafEl.querySelector('.workspace-leaf-content[data-path]');
        if (contentEl) {
          return contentEl.getAttribute('data-path');
        }
        // 备选：直接检查 leaf 的属性
        const pathAttr = (leafEl as HTMLElement).getAttribute('data-path');
        if (pathAttr) return pathAttr;
      }
    } catch {
      // ignore
    }
    return null;
  }

  private buildDecorationsInner(view: EditorView): DecorationSet {
    const doc = view.state.doc.toString();

    // 如果文档为空，直接返回空 set
    if (!doc || doc.length === 0) {
      return Decoration.none;
    }

    // 收集所有装饰项
    const decoItems: { from: number; to: number; deco: Decoration }[] = [];

    // ── 1. 解析 <mark> 标签装饰 ──
    const marks = this.parseMarkTags(doc);
    const validMarks = this.filterOverlapping(marks);

    for (const mark of validMarks) {
      // 隐藏 <mark ...> 开标签
      decoItems.push({
        from: mark.openFrom,
        to: mark.openTo,
        deco: Decoration.replace({
          widget: new MarkOpenWidget(mark.uuid, mark.type, mark.color, mark.note),
          block: false,
        }),
      });

      // 高亮内部文本
      const className = `markvault-${mark.type} markvault-${mark.color}`;
      const styleStr = this.getStyleForType(mark.type, mark.colorHex);
      decoItems.push({
        from: mark.openTo,
        to: mark.closeFrom,
        deco: Decoration.mark({
          class: className,
          attributes: { style: styleStr, 'data-uuid': mark.uuid, 'data-kind': 'inline' },
        }),
      });

      // 隐藏 </mark> 闭标签
      decoItems.push({
        from: mark.closeFrom,
        to: mark.closeTo,
        deco: Decoration.replace({
          widget: new MarkCloseWidget(),
          block: false,
        }),
      });
    }

    // ── 2. Span 标注装饰 ──
    // 优先使用注入的 resolver（Obsidian API），备选 DOM 属性
    const filePath = resolveFilePath() || this.getFilePathFromView(view);
    if (filePath) {
      const spanAnnotations = getSpanCacheForFile(filePath);
      if (spanAnnotations.length > 0) {
        for (const spanAnn of spanAnnotations) {
          const preset = PRESET_COLORS.find(c => c.id === spanAnn.color);
          const colorHex = preset ? preset.hex : spanAnn.color;

          // 锚点行提示：给锚点行添加轻量左侧色条
          if (spanAnn.anchorLine >= 0 && spanAnn.anchorLine < view.state.doc.lines) {
            const lineStart = view.state.doc.line(spanAnn.anchorLine + 1).from;
            decoItems.push({
              from: lineStart,
              to: lineStart,
              deco: Decoration.line({
                class: `markvault-span-anchor markvault-span-${spanAnn.color}`,
              }),
            });
          }

          // 文本片段装饰
          for (const range of spanAnn.spanRanges) {
            // 确保范围在文档内
            const from = Math.max(0, Math.min(range.from, doc.length));
            const to = Math.max(from, Math.min(range.to, doc.length));
            if (from >= to) continue;

            const className = `markvault-${spanAnn.type} markvault-${spanAnn.color}`;
            const styleStr = this.getStyleForType(spanAnn.type, colorHex);
            decoItems.push({
              from,
              to,
              deco: Decoration.mark({
                class: className,
                attributes: {
                  style: styleStr,
                  'data-uuid': spanAnn.uuid,
                  'data-kind': 'span',
                },
              }),
            });
          }
        }
      }
    }

    // ── 3. 块级/Span 锚点隐藏 ──
    // 在编辑模式下隐藏 %%markvault:...%% 和 %%markvault-span:...%% 锚点行
    const lines = doc.split('\n');
    let lineOffset = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      const trimmed = lineText.trim();
      if (/^%%markvault(-span)?:[^:%]+:[^:%]+:[^:%]+(?::[^%]*)?%%$/.test(trimmed)) {
        const from = lineOffset;
        const to = lineOffset + lineText.length;
        // 隐藏整行锚点内容，但保留换行符
        decoItems.push({
          from,
          to,
          deco: Decoration.replace({
            widget: new BlockAnchorWidget(),
            block: false,
          }),
        });
      }
      lineOffset += lineText.length + 1; // +1 for \n
    }

    // 按位置排序（RangeSetBuilder 要求递增）
    decoItems.sort((a, b) => a.from - b.from || a.to - b.to);

    const builder = new RangeSetBuilder<Decoration>();
    let lastFrom = -1;
    for (const item of decoItems) {
      // RangeSetBuilder 要求 from >= 上一个 from，且 from < to（mark类型）或 from == to（line/widget类型）
      if (item.from < lastFrom) continue;
      try {
        builder.add(item.from, item.to, item.deco);
        lastFrom = item.from;
      } catch (err) {
        // 跳过冲突的装饰
        console.warn('MarkVault: decoration conflict at', item.from, err);
      }
    }

    return builder.finish();
  }

  /**
   * 过滤掉重叠的标注（保留第一个，跳过后续重叠的）
   * RangeSetBuilder 不允许重叠范围
   */
  private filterOverlapping(marks: Array<{
    openFrom: number; openTo: number; closeFrom: number; closeTo: number;
    uuid: string; type: AnnotationType; color: string; colorHex: string; note: string;
  }>): Array<{
    openFrom: number; openTo: number; closeFrom: number; closeTo: number;
    uuid: string; type: AnnotationType; color: string; colorHex: string; note: string;
  }> {
    if (marks.length <= 1) return marks;

    const result = [marks[0]];
    let lastEnd = marks[0].closeTo;

    for (let i = 1; i < marks.length; i++) {
      if (marks[i].openFrom >= lastEnd) {
        result.push(marks[i]);
        lastEnd = marks[i].closeTo;
      } else {
        // 跳过重叠的标注
        console.warn('MarkVault: skipping overlapping mark at offset', marks[i].openFrom);
      }
    }

    return result;
  }

  /**
   * 解析文档中所有 <mark> 标签的位置和属性
   */
  private parseMarkTags(doc: string): Array<{
    openFrom: number;
    openTo: number;
    closeFrom: number;
    closeTo: number;
    uuid: string;
    type: AnnotationType;
    color: string;
    colorHex: string;
    note: string;
  }> {
    const results: Array<{
      openFrom: number;
      openTo: number;
      closeFrom: number;
      closeTo: number;
      uuid: string;
      type: AnnotationType;
      color: string;
      colorHex: string;
      note: string;
    }> = [];

    MARK_FULL_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = MARK_FULL_REGEX.exec(doc)) !== null) {
      try {
        const attrsRaw = match[1];
        const attrs = this.parseAttributes(attrsRaw);

        // 必须有 uuid 才是 MarkVault 标注
        if (!attrs.uuid) continue;

        const openFrom = match.index;
        // 计算 <mark ...> 的结束位置
        const gtIndex = match[0].indexOf('>');
        if (gtIndex === -1) continue;
        const openTo = openFrom + gtIndex + 1;

        // 内部文本范围
        const innerStart = openTo;
        const innerEnd = innerStart + match[2].length;
        const closeFrom = innerEnd;
        const closeTo = openFrom + match[0].length;

        // 验证范围有效性
        if (closeTo > doc.length || innerEnd < innerStart) continue;

        const color = attrs.color || 'yellow';
        const type = (attrs.type || 'highlight') as AnnotationType;
        const preset = PRESET_COLORS.find(c => c.id === color);
        const colorHex = preset ? preset.hex : color;

        results.push({
          openFrom,
          openTo,
          closeFrom,
          closeTo,
          uuid: attrs.uuid,
          type,
          color,
          colorHex,
          note: attrs.note || '',
        });
      } catch {
        // 跳过解析失败的标签
      }
    }

    return results;
  }

  /**
   * 解析属性字符串为键值对
   */
  private parseAttributes(raw: string): Record<string, string> {
    const result: Record<string, string> = {};
    ATTR_EXTRACT_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ATTR_EXTRACT_REGEX.exec(raw)) !== null) {
      result[m[1]] = m[2];
    }
    return result;
  }

  /**
   * 根据标注类型和颜色生成 CSS 样式字符串
   */
  private getStyleForType(type: AnnotationType, hex: string): string {
    switch (type) {
      case 'highlight':
        return `background-color: ${hex}66; border-radius: 2px; padding: 1px 0;`;
      case 'bold':
        return `font-weight: bold; border-bottom: 2px solid ${hex}; padding: 1px 0;`;
      case 'underline':
        return `text-decoration: underline; text-decoration-color: ${hex}; text-underline-offset: 2px;`;
      default:
        return `background-color: ${hex}66;`;
    }
  }
}

// ─── Plugin Spec ─────────────────────────────────────────

const markvaultPluginSpec: PluginSpec<MarkVaultDecorator> = {
  decorations: (value: MarkVaultDecorator) => value.decorations,
};

// ─── 导出 ────────────────────────────────────────────────

/**
 * CM6 ViewPlugin 实例
 * 在 main.ts 中通过 this.registerEditorExtension(markvaultDecorationPlugin) 注册
 */
export const markvaultDecorationPlugin: Extension = ViewPlugin.fromClass(
  MarkVaultDecorator,
  markvaultPluginSpec,
);

/**
 * 阅读模式 DOM 高亮渲染
 * 在阅读模式下，Obsidian 渲染 Markdown 为 HTML，
 * <mark> 标签会被保留为 DOM 元素
 */
export function applyReadingModeHighlights(
  body: HTMLElement,
  _annotations: import('../types/annotation').Annotation[],
): void {
  const marks = body.querySelectorAll('mark[data-uuid]');
  marks.forEach((mark) => {
    const el = mark as HTMLElement;
    const type = (el.getAttribute('data-type') || 'highlight') as AnnotationType;
    const color = el.getAttribute('data-color') || 'yellow';

    const preset = PRESET_COLORS.find(c => c.id === color);
    const hex = preset ? preset.hex : color;

    el.addClass('markvault-mark');
    el.addClass(`markvault-${type}`);
    el.addClass(`markvault-${color}`);

    applyStyleToElement(el, type, hex);

    const note = el.getAttribute('data-note');
    if (note) {
      el.setAttribute('title', note);
      el.addClass('markvault-has-note');
    }
  });
}

/**
 * 给 DOM 元素应用标注样式
 */
export function applyStyleToElement(el: HTMLElement, type: AnnotationType, hex: string): void {
  switch (type) {
    case 'highlight':
      el.style.backgroundColor = `${hex}66`;
      el.style.borderRadius = '2px';
      el.style.padding = '1px 0';
      break;
    case 'bold':
      el.style.fontWeight = 'bold';
      el.style.borderBottom = `2px solid ${hex}`;
      el.style.padding = '1px 0';
      break;
    case 'underline':
      el.style.textDecoration = 'underline';
      el.style.textDecorationColor = hex;
      el.style.textUnderlineOffset = '2px';
      break;
  }
}
