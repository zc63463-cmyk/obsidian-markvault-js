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

import { EditorSelection, RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  layer,
  type LayerMarker,
  type PluginSpec,
  type PluginValue,
  RectangleMarker,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { PRESET_COLORS, type AnnotationType, type SpanRange } from '../types/annotation';
import { findNativeWrapper, NATIVE_ANCHOR_REGEX } from './native-annotation';
import { REGION_ANCHOR_REGEX } from './region-annotation';
import { parseBlockAnchors, findBlockTargetLine, parseBlockDoubleAnchors } from './annotation-parser';

// ─── Region Layer 重绘触发器 ──────────────────────────────

/**
 * 自定义 StateEffect：用于在 region 缓存更新后强制 CM6 layer 重绘。
 *
 * 问题：regionLayerExtension 的 update() 只在 docChanged || viewportChanged 时返回 true。
 * 当 updateRegionCache() 异步填充缓存后，没有任何事件通知 CM6 layer 重新渲染。
 * 发送此 effect 后，layer 的 update() 会返回 true，触发 markers() 重新计算。
 */
export const regionCacheUpdatedEffect = StateEffect.define<void>();

/** 当前活跃的 EditorView 引用，由 main.ts 注入 */
let activeEditorView: EditorView | null = null;

/** 注入当前活跃的 EditorView（在 main.ts 的 active-leaf-change 中调用） */
export function setActiveEditorView(view: EditorView | null): void {
  activeEditorView = view;
}

/**
 * 在 region 缓存更新后强制 CM6 layer 重绘。
 * 通过发送 regionCacheUpdatedEffect 触发 layer 的 update() 返回 true。
 * 必须在 updateRegionCache() 完成后调用。
 */
export function requestRegionLayerRedraw(): void {
  if (activeEditorView) {
    try {
      // 使用 any 访问 destroyed 属性（CM6 内部标记，TypeScript 定义为 private）
      const view = activeEditorView as any;
      if (view.destroyed) return;
      activeEditorView.dispatch({
        effects: [regionCacheUpdatedEffect.of(undefined)],
      });
    } catch {
      // view 可能已销毁，忽略
    }
  }
}

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

/**
 * 从 CM6 view 推断当前文件路径
 * 通过 Obsidian 的 DOM 结构查找 .workspace-leaf 的 data-path 属性
 */
function getFilePathFromView(view: EditorView): string | null {
  try {
    const dom = view.dom;
    const leafEl = dom.closest('.workspace-leaf');
    if (leafEl) {
      const contentEl = leafEl.querySelector('.workspace-leaf-content[data-path]');
      if (contentEl) {
        return contentEl.getAttribute('data-path');
      }
      const pathAttr = (leafEl as HTMLElement).getAttribute('data-path');
      if (pathAttr) return pathAttr;
    }
  } catch {
    // ignore
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

// ─── Region Annotation Cache ──────────────────────────────────

/** Region 标注缓存数据（从 DB 加载） */
export interface RegionAnnotationData {
  uuid: string;
  type: AnnotationType;
  color: string;
  startOffset: number;
  endOffset: number;
  note: string;
}

const regionCache = new Map<string, RegionAnnotationData[]>();

export function updateRegionCacheForFile(filePath: string, annotations: RegionAnnotationData[]): void {
  if (annotations.length > 0) {
    regionCache.set(filePath, annotations);
  } else {
    regionCache.delete(filePath);
  }
}

export function getRegionCacheForFile(filePath: string): RegionAnnotationData[] {
  return regionCache.get(filePath) || [];
}

export function clearRegionCacheForFile(filePath: string): void {
  regionCache.delete(filePath);
}

export function clearRegionCache(): void {
  regionCache.clear();
}

// ─── Block Annotation Cache ──────────────────────────────────

/** Block 标注缓存数据（从 DB 加载） */
export interface BlockAnnotationData {
  uuid: string;
  type: AnnotationType;
  color: string;
  targetLine: number;
  note: string;
}

const blockCache = new Map<string, BlockAnnotationData[]>();

export function updateBlockCacheForFile(filePath: string, annotations: BlockAnnotationData[]): void {
  if (annotations.length > 0) {
    blockCache.set(filePath, annotations);
  } else {
    blockCache.delete(filePath);
  }
}

export function getBlockCacheForFile(filePath: string): BlockAnnotationData[] {
  return blockCache.get(filePath) || [];
}

export function clearBlockCacheForFile(filePath: string): void {
  blockCache.delete(filePath);
}

export function clearBlockCache(): void {
  blockCache.clear();
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

/**
 * 隐藏 %%mv:i:...%% 自然语法锚点的 Widget
 */
class NativeAnchorWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.className = 'markvault-native-anchor-hidden';
    span.style.display = 'none';
    return span;
  }

  ignoreEvent() {
    return true;
  }
}

/**
 * Region 锚点标记 Widget
 * 编辑模式下把隐藏的 region start/end 锚点替换为一个可见的小符号，
 * 让用户能感知 region 边界，同时不遮挡正文。
 */
class RegionAnchorMarkerWidget extends WidgetType {
  constructor(
    readonly uuid: string,
    readonly type: AnnotationType,
    readonly color: string,
    readonly position: 'start' | 'end',
  ) {
    super();
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = `markvault-region-anchor-marker markvault-region-anchor-${this.position}`;
    span.textContent = this.position === 'start' ? '▭' : '▭';
    span.title = `Region ${this.position}`;
    span.style.color = this.getColorHex();
    span.style.opacity = '0.6';
    span.style.fontSize = '0.85em';
    span.style.padding = '0 1px';
    span.style.userSelect = 'none';
    span.style.cursor = 'pointer';
    span.dataset.uuid = this.uuid;
    span.dataset.position = this.position;
    return span;
  }

  private getColorHex(): string {
    const preset = PRESET_COLORS.find(c => c.id === this.color);
    return preset ? preset.hex : this.color;
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
    // docChanged/viewportChanged: 正常文档/视口变化时重绘
    // regionCacheUpdatedEffect: 缓存更新后强制重绘（解决异步缓存竞态）
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.buildDecorations(update.view);
      return;
    }
    for (const effect of update.transactions.flatMap(t => t.effects)) {
      if (effect.is(regionCacheUpdatedEffect)) {
        this.decorations = this.buildDecorations(update.view);
        return;
      }
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
    const filePath = resolveFilePath() || getFilePathFromView(view);
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

    // ── 3. Block 标注行装饰 ──
    // 给 block 标注的目标行添加左侧色条/背景
    // 🔧 关键修复：每次渲染时从当前文档重新解析锚点并定位目标块，
    // 避免 targetLine 在编辑后偏移导致装饰位置错误。
    const blockAnchorMap = new Map<string, number>();

    // 3a. 旧单锚点 block 标注
    const blockAnchors = parseBlockAnchors(doc);
    for (const anchor of blockAnchors) {
      if (anchor.anchorKind !== 'block') continue;
      const targetLine = findBlockTargetLine(doc, anchor.anchorLine);
      blockAnchorMap.set(anchor.uuid, targetLine);
    }

    // 3b. 新双锚点 block 标注：start 锚点的下一有效行即为目标行
    const doubleBlockAnchors = parseBlockDoubleAnchors(doc);
    const doubleBlockByUuid = new Map<string, { start?: { anchorLine: number }; end?: { anchorLine: number } }>();
    for (const anchor of doubleBlockAnchors) {
      const entry = doubleBlockByUuid.get(anchor.uuid) || {};
      if (anchor.position === 'start') {
        if (!entry.start) entry.start = { anchorLine: anchor.anchorLine };
      } else {
        if (!entry.end) entry.end = { anchorLine: anchor.anchorLine };
      }
      doubleBlockByUuid.set(anchor.uuid, entry);
    }
    for (const [uuid, entry] of doubleBlockByUuid.entries()) {
      if (!entry.start) continue;
      const targetLine = findBlockTargetLine(doc, entry.start.anchorLine);
      blockAnchorMap.set(uuid, targetLine);
    }

    if (filePath) {
      const blockAnnotations = getBlockCacheForFile(filePath);
      for (const blockAnn of blockAnnotations) {
        const targetLine = blockAnchorMap.get(blockAnn.uuid) ?? blockAnn.targetLine;
        const lineNumber = targetLine + 1;
        if (lineNumber < 1 || lineNumber > view.state.doc.lines) continue;
        const lineStart = view.state.doc.line(lineNumber).from;
        decoItems.push({
          from: lineStart,
          to: lineStart,
          deco: Decoration.line({
            class: `markvault-block-line-deco markvault-block-${blockAnn.type} markvault-block-${blockAnn.color}`,
          }),
        });
      }
    }

    // ── 4. Native 标注装饰（bold/highlight/underline） ──
    // 统一处理所有 native 类型：隐藏锚点与 wrapper 标签，只给内部文本加 class
    NATIVE_ANCHOR_REGEX.lastIndex = 0;
    let nativeMatch: RegExpExecArray | null;
    while ((nativeMatch = NATIVE_ANCHOR_REGEX.exec(doc)) !== null) {
      const anchorStart = nativeMatch.index;
      const anchorEnd = anchorStart + nativeMatch[0].length;
      const uuid = nativeMatch[1];
      const type = nativeMatch[2] as AnnotationType;
      const color = nativeMatch[3];

      const wrapper = findNativeWrapper(doc, anchorEnd, type);
      if (wrapper) {
        // 隐藏锚点（及锚点到 wrapper 之间的空白）
        decoItems.push({
          from: anchorStart,
          to: wrapper.wrapperStart,
          deco: Decoration.replace({ widget: new NativeAnchorWidget(), block: false }),
        });

        // 隐藏 wrapper 开标签 / 旧版开头符号
        decoItems.push({
          from: wrapper.wrapperStart,
          to: wrapper.contentStart,
          deco: Decoration.replace({ widget: new NativeAnchorWidget(), block: false }),
        });

        // 高亮内部文本
        decoItems.push({
          from: wrapper.contentStart,
          to: wrapper.contentEnd,
          deco: Decoration.mark({
            class: `markvault-${type} markvault-${color}`,
            attributes: {
              'data-uuid': uuid,
              'data-type': type,
              'data-color': color,
              'data-kind': 'inline',
            },
          }),
        });

        // 隐藏 wrapper 闭标签 / 旧版结尾符号
        decoItems.push({
          from: wrapper.contentEnd,
          to: wrapper.wrapperEnd,
          deco: Decoration.replace({ widget: new NativeAnchorWidget(), block: false }),
        });
      } else {
        // 至少把孤儿锚点隐藏掉，避免污染编辑视图
        decoItems.push({
          from: anchorStart,
          to: anchorEnd,
          deco: Decoration.replace({ widget: new NativeAnchorWidget(), block: false }),
        });
      }
    }

    // ── 4. Region 锚点隐藏 + 内容装饰 ──
    // 在编辑模式下隐藏 %%markvault-region:...:start%% 和 %%markvault-region:...:end%%
    // 并给锚点之间的内容加 CSS class（mark/line），替代 CM6 layer 几何覆盖层。
    interface RegionAnchorMatch {
      index: number;
      length: number;
      uuid: string;
      type: AnnotationType;
      color: string;
      position: 'start' | 'end';
    }
    const regionAnchors: RegionAnchorMatch[] = [];
    REGION_ANCHOR_REGEX.lastIndex = 0;
    let regionMatch: RegExpExecArray | null;
    while ((regionMatch = REGION_ANCHOR_REGEX.exec(doc)) !== null) {
      regionAnchors.push({
        index: regionMatch.index,
        length: regionMatch[0].length,
        uuid: regionMatch[1],
        type: regionMatch[2] as AnnotationType,
        color: regionMatch[3],
        position: regionMatch[4] as 'start' | 'end',
      });
      decoItems.push({
        from: regionMatch.index,
        to: regionMatch.index + regionMatch[0].length,
        deco: Decoration.replace({
          widget: new RegionAnchorMarkerWidget(
            regionMatch[1],
            regionMatch[2] as AnnotationType,
            regionMatch[3],
            regionMatch[4] as 'start' | 'end',
          ),
          block: false,
        }),
      });
    }

    // 编辑模式下 region 用淡淡的 inline 背景 + 边界小符号标识，
    // 内容范围的高亮仍可通过 Obsidian 原生选区触发。
    const regionByUuid = new Map<string, { start?: RegionAnchorMatch; end?: RegionAnchorMatch }>();
    for (const a of regionAnchors) {
      const entry = regionByUuid.get(a.uuid) || {};
      if (a.position === 'start') {
        if (!entry.start) entry.start = a;
      } else {
        if (!entry.end) entry.end = a;
      }
      regionByUuid.set(a.uuid, entry);
    }
    for (const [uuid, entry] of regionByUuid.entries()) {
      if (!entry.start || !entry.end) continue;
      const contentStart = entry.start.index + entry.start.length;
      const contentEnd = entry.end.index;
      if (contentStart >= contentEnd) continue;

      // 淡淡的 inline 背景，不覆盖整行
      decoItems.push({
        from: contentStart,
        to: contentEnd,
        deco: Decoration.mark({
          class: `markvault-region-edit-bg markvault-region-${entry.start.color}`,
          attributes: {
            'data-uuid': uuid,
            'data-kind': 'region',
          },
        }),
      });

      // 块级内容（代码块/公式块）用左侧竖线标识，inline mark 覆盖不到 widget
      try {
        const blockLines = this.findRegionBlockLines(view.state.doc, contentStart, contentEnd);
        for (const line of blockLines) {
          decoItems.push({
            from: line.from,
            to: line.from,
            deco: Decoration.line({
              class: `markvault-region-block-line markvault-region-${entry.start.color}`,
            }),
          });
        }
      } catch {
        // 忽略 line 解析异常
      }
    }

    // 🔧 4b. 子串兜底：捕获所有未被严格正则匹配的 region 锚点文本
    // 处理场景：锚点分隔符损坏（如只有单个 %）、note 中含 %% 导致提前截断等极端情况。
    // 策略：扫描文档中所有含 "markvault-region" 的行，将未隐藏的范围补充隐藏。
    {
      const hiddenRanges: Array<{ from: number; to: number }> = [];
      for (const di of decoItems) {
        hiddenRanges.push({ from: di.from, to: di.to });
      }
      // 按行扫描
      const docLines = doc.split('\n');
      let lineOffset = 0;
      for (let li = 0; li < docLines.length; li++) {
        const lineText = docLines[li];
        const idx = lineText.indexOf('markvault-region');
        if (idx === -1) {
          lineOffset += lineText.length + 1;
          continue;
        }
        // 找到含 markvault-region 的行，检查是否已被隐藏
        const absStart = lineOffset + idx;
        // 找到这行中 markvault-region 相关锚点的完整范围
        // 从当前位置向前找 % 开头，向后找 %% 结尾
        let rangeStart = absStart;
        let rangeEnd = lineOffset + lineText.length;
        // 向前扫描：找到 %% 或 % 开头
        for (let p = absStart - 1; p >= lineOffset; p--) {
          if (doc[p] === '%') {
            rangeStart = p;
            // 继续向前看是否还有一个 %
            if (p > 0 && doc[p - 1] === '%') {
              rangeStart = p - 1;
            }
            break;
          }
        }
        // 向后扫描：找到 %% 结尾
        for (let p = absStart; p < lineOffset + lineText.length - 1; p++) {
          if (doc[p] === '%' && doc[p + 1] === '%') {
            rangeEnd = p + 2;
            break;
          }
        }

        // 检查是否已被隐藏
        const isAlreadyHidden = hiddenRanges.some(
          r => rangeStart >= r.from && rangeEnd <= r.to
        );
        if (!isAlreadyHidden) {
          decoItems.push({
            from: rangeStart,
            to: rangeEnd,
            deco: Decoration.replace({
              widget: new BlockAnchorWidget(),
              block: false,
            }),
          });
        }
        lineOffset += lineText.length + 1;
      }
    }

    // ── 5. 块级/Span 锚点隐藏 ──
    // 在编辑模式下隐藏 %%markvault:...%% 和 %%markvault-span:...%% 锚点行
    const lines = doc.split('\n');
    let lineOffset = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      const trimmed = lineText.trim();
      const isOldBlockOrSpan = /^%%markvault(-span)?:[^:%]+:[^:%]+:[^:%]+(?::[^%]*)?%%$/.test(trimmed);
      const isDoubleBlock = /^%%markvault-block:[^:%]+:[^:%]+:[^:%]+:(start|end):[^%]*%%$/.test(trimmed);
      if (isOldBlockOrSpan || isDoubleBlock) {
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
   * 找出 region 范围内属于代码块 / 公式块的行
   * 编辑模式下这些行是 CM6 widget，inline mark 覆盖不到，需要单独加行级标识。
   */
  private findRegionBlockLines(
    cmDoc: import('@codemirror/state').Text,
    startOffset: number,
    endOffset: number,
  ): Array<{ from: number }> {
    const result: Array<{ from: number }> = [];
    const startLine = cmDoc.lineAt(startOffset).number;
    const endLine = cmDoc.lineAt(endOffset).number;

    let inCodeBlock = false;
    let inMathBlock = false;

    for (let ln = 1; ln <= cmDoc.lines; ln++) {
      const line = cmDoc.line(ln);
      const trimmed = line.text.trim();

      if (!inCodeBlock && !inMathBlock) {
        if (trimmed.startsWith('```')) {
          inCodeBlock = true;
        } else if (trimmed === '$$') {
          inMathBlock = true;
        }
      } else {
        if (inCodeBlock && trimmed.startsWith('```')) {
          inCodeBlock = false;
        } else if (inMathBlock && trimmed === '$$') {
          inMathBlock = false;
        }
      }

      if (ln >= startLine && ln <= endLine && (inCodeBlock || inMathBlock)) {
        result.push({ from: line.from });
      }
    }

    return result;
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

        // native 标注由专门的 native 循环处理，避免重复装饰
        if (attrs.class && attrs.class.includes('markvault-native')) continue;

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

// ─── Region Layer ────────────────────────────────────────

/**
 * Region 标注的背景层
 * 使用 RectangleMarker.forRange 为每个 region 范围绘制选择式背景矩形，
 * 可覆盖普通文本、公式/代码 Widget、图片占位等。
 */
const regionLayerExtension: Extension = layer({
  above: true,
  class: 'markvault-region-layer',
  update(update) {
    // docChanged/viewportChanged: 正常文档/视口变化时重绘
    // regionCacheUpdatedEffect: 缓存更新后强制重绘（解决异步缓存竞态）
    if (update.docChanged || update.viewportChanged) return true;
    for (const effect of update.transactions.flatMap(t => t.effects)) {
      if (effect.is(regionCacheUpdatedEffect)) return true;
    }
    return false;
  },
  markers(view) {
    const filePath = resolveFilePath() || getFilePathFromView(view);
    if (!filePath) return [];

    const regions = getRegionCacheForFile(filePath);
    const markers: LayerMarker[] = [];

    for (const region of regions) {
      const className = `markvault-region-layer-bg markvault-region-${region.type} markvault-region-${region.color}`;
      const range = EditorSelection.range(region.startOffset, region.endOffset);
      markers.push(...RectangleMarker.forRange(view, className, range));
    }

    return markers;
  },
});

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
 * Region 背景层扩展
 * 需要与 markvaultDecorationPlugin 一起注册到编辑器
 */
export const markvaultRegionLayer: Extension = regionLayerExtension;

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
