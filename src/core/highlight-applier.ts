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
import { PRESET_COLORS, type AnnotationType } from '../types/annotation';
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

/** 🔧 P1-22 修复：追踪所有活跃的 EditorView，而非仅一个 */
const activeEditorViews = new Set<EditorView>();

/**
 * 注入当前活跃的 EditorView（在 main.ts 的 active-leaf-change / sync-engine 中调用）
 * 🔧 P0-1 修复：view=null 时清理已销毁的 view，而非静默忽略
 */
export function setActiveEditorView(view: EditorView | null): void {
  if (view) {
    activeEditorViews.add(view);
  } else {
    // 🔧 P0-1：null 表示当前无活跃编辑器，清理所有已销毁的 view
    for (const v of activeEditorViews) {
      try {
        if ((v as any).destroyed || !v.state?.field) {
          activeEditorViews.delete(v);
        }
      } catch {
        activeEditorViews.delete(v);
      }
    }
  }
}

/** 🔧 P1-22 修复：移除已销毁的 EditorView（在 onunload 中调用） */
export function removeEditorView(view: EditorView): void {
  activeEditorViews.delete(view);
}

/** 🔧 P0-1 修复：清除所有活跃的 EditorView（在 plugin onunload 中调用） */
export function clearActiveEditorViews(): void {
  activeEditorViews.clear();
}

/**
 * 在 region 缓存更新后强制 CM6 layer 重绘。
 * 🔧 P1-22 修复：向所有活跃的 EditorView 发送 effect，确保多 leaf 场景下都能重绘。
 * 必须在 updateRegionCache() 完成后调用。
 */
export function requestRegionLayerRedraw(): void {
  for (const view of activeEditorViews) {
    try {
      const v = view as any;
      if (v.destroyed) { activeEditorViews.delete(view); continue; }
      if (!view.state?.field) { activeEditorViews.delete(view); continue; }
      view.dispatch({
        effects: [regionCacheUpdatedEffect.of(undefined)],
      });
    } catch (err) {
      console.debug('MarkVault: regionLayer redraw dispatch failed, view likely destroyed', err);
      activeEditorViews.delete(view);
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
    } catch (err) {
      // fallback to DOM
      console.debug('MarkVault: filePathResolver failed, falling back to DOM', err);
    }
  }
  return null;
}

// ─── P1-17: 编辑模式点击标注回调 ──────────────────────────

/**
 * 🔧 P1-17 修复：编辑模式点击标注回调
 * 由 main.ts 注入，当用户在编辑模式下点击 data-uuid 元素时调用。
 */
let annotationClickHandler: ((uuid: string) => void) | null = null;

/** 注入编辑模式点击回调（在 main.ts onload 中调用） */
export function setAnnotationClickHandler(handler: ((uuid: string) => void) | null): void {
  annotationClickHandler = handler;
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
  } catch (err) {
    // ignore — DOM queries can fail if view is being destroyed
    console.debug('MarkVault: DOM path extraction failed', err);
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


// ─── 缓存层导入（从 annotation-cache.ts 提取）──────────────────
export {
  type SpanAnnotationData,
  type RegionAnnotationData,
  type BlockAnnotationData,
  updateSpanCacheForFile,
  getSpanCacheForFile,
  clearSpanCacheForFile,
  clearSpanCache,
  updateRegionCacheForFile,
  getRegionCacheForFile,
  clearRegionCacheForFile,
  clearRegionCache,
  updateBlockCacheForFile,
  getBlockCacheForFile,
  clearBlockCacheForFile,
  clearBlockCache,
} from './annotation-cache';

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
    // 🔧 P1-17 修复：返回 false 让点击事件冒泡到 DOM 事件处理器
    return false;
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
    return false;
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
    return false;
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
    return false;
  }
}

/**
 * 🔧 P1-18 修复：Block 标注编辑模式徽章
 * 在编辑模式下给 block 标注的目标行添加类型+颜色徽章，
 * 与阅读模式的 block-type-badge 保持视觉一致性。
 */
class BlockBadgeWidget extends WidgetType {
  constructor(
    readonly uuid: string,
    readonly type: AnnotationType,
    readonly color: string,
  ) {
    super();
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = `markvault-block-badge markvault-block-badge-${this.type} markvault-block-badge-${this.color}`;
    span.dataset.uuid = this.uuid;
    span.dataset.kind = 'block';

    const preset = PRESET_COLORS.find(c => c.id === this.color);
    const hex = preset ? preset.hex : this.color;

    // 类型图标
    const icon = document.createElement('span');
    icon.className = 'markvault-block-badge-icon';
    icon.textContent = this.type === 'bold' ? '𝗕' : this.type === 'underline' ? 'U̲' : '🎨';

    // 颜色点
    const dot = document.createElement('span');
    dot.className = 'markvault-block-badge-dot';
    dot.style.backgroundColor = hex;

    span.appendChild(icon);
    span.appendChild(dot);
    return span;
  }

  ignoreEvent() {
    return false;
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
    // 🔧 P1-17 修复：返回 false 允许 region 锚点标记点击交互
    return false;
  }
}

// ─── ViewPlugin 实现 ─────────────────────────────────────

class MarkVaultDecorator implements PluginValue {
  decorations: DecorationSet;
  /** 🔧 P1-17 修复：编辑模式标注点击事件处理器引用（destroy 时清理） */
  private clickHandler: ((e: MouseEvent) => void) | null = null;
  /** 🔧 P1-21 修复：debounce 定时器，快速连续输入时合并重绘 */
  private _rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(view: EditorView) {
    this.decorations = this.buildDecorations(view);

    // 🔧 P1-17 修复：注册编辑模式标注点击事件监听
    this.clickHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const uuidEl = target.closest('[data-uuid]');
      if (uuidEl) {
        // 🔧 P1-20 修复：优先使用 data-uuids（多 region 重叠），否则用 data-uuid
        const uuidsAttr = uuidEl.getAttribute('data-uuids');
        const uuid = uuidsAttr ? uuidsAttr.split(',')[0] : uuidEl.getAttribute('data-uuid');
        if (uuid && annotationClickHandler) {
          e.preventDefault();
          e.stopPropagation();
          annotationClickHandler(uuid);
        }
      }
    };
    view.dom.addEventListener('click', this.clickHandler);
  }

  update(update: ViewUpdate) {
    // docChanged/viewportChanged: 正常文档/视口变化时重绘
    // regionCacheUpdatedEffect: 缓存更新后强制重绘（解决异步缓存竞态）
    if (update.docChanged) {
      // 🔧 P1-21 修复：文档变更时 debounce 100ms，合并快速连续输入
      if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
      this._rebuildTimer = setTimeout(() => {
        this.decorations = this.buildDecorations(update.view);
        this._rebuildTimer = null;
      }, 100);
      return;
    }
    if (update.viewportChanged) {
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
    // 🔧 P1-17 修复：清理点击事件监听
    if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
    this.clickHandler = null;
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

    // 🔧 P1-21 修复：计算可视范围，跳过视口外的标注
    const viewportRanges = view.visibleRanges;
    const vpMin = viewportRanges.length > 0 ? viewportRanges[0].from : 0;
    const vpMax = viewportRanges.length > 0 ? viewportRanges[viewportRanges.length - 1].to : doc.length;
    // 扩展视口范围 ±2000 字符，确保边角标注也能渲染
    const vpFrom = Math.max(0, vpMin - 2000);
    const vpTo = Math.min(doc.length, vpMax + 2000);

    // 🔧 P0-7 修复：预扫描代码块/数学块范围
    // CM6 Widget（代码块/数学块）内的 inline Decoration 无法覆盖，
    // <mark> 标签在这些区域内会导致渲染异常。
    // 解决方案：在创建 decoration 前标记这些区域，跳过内部标注。
    const fencedRanges = this.computeFencedRanges(doc);

    // 收集所有装饰项
    const decoItems: { from: number; to: number; deco: Decoration }[] = [];

    // ── 1. 解析 <mark> 标签装饰 ──
    const marks = this.parseMarkTags(doc);
    // 🔧 P0-7 修复：过滤掉在代码块/数学块内的 <mark> 标签
    const safeMarks = marks.filter(m => !this.isInFencedRange(fencedRanges, m.openFrom, m.closeTo));
    const validMarks = this.filterOverlapping(safeMarks);

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
      let styleStr = this.getStyleForType(mark.type, mark.colorHex);
      // 🔧 P0-8 修复：重叠标注降低 opacity
      if (mark.overlapOpacity !== undefined) {
        styleStr += ` opacity: ${mark.overlapOpacity};`;
      }
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
            // 🔧 P1-21 修复：跳过视口外的 span range
            if (from > vpTo || to < vpFrom) continue;

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
        // 🔧 P1-21 修复：跳过视口外的 block
        if (lineStart > vpTo || lineStart < vpFrom) continue;

        // 行级色条
        decoItems.push({
          from: lineStart,
          to: lineStart,
          deco: Decoration.line({
            class: `markvault-block-line-deco markvault-block-${blockAnn.type} markvault-block-${blockAnn.color}`,
          }),
        });

        // 🔧 P1-18 修复：block 编辑模式徽章（行首 inline widget）
        decoItems.push({
          from: lineStart,
          to: lineStart,
          deco: Decoration.widget({
            widget: new BlockBadgeWidget(blockAnn.uuid, blockAnn.type, blockAnn.color),
            block: false,
            side: -1, // 放在行首之前
          }),
        });
      }
    }

    // ── 4. Native 标注装饰（bold/highlight/underline） ──
    // 统一处理所有 native 类型：隐藏锚点与 wrapper 标签，只给内部文本加 class
    // 🔧 P0-7 修复：跳过代码块/数学块内的 native 标注
    NATIVE_ANCHOR_REGEX.lastIndex = 0;
    let nativeMatch: RegExpExecArray | null;
    while ((nativeMatch = NATIVE_ANCHOR_REGEX.exec(doc)) !== null) {
      const anchorStart = nativeMatch.index;
      const anchorEnd = anchorStart + nativeMatch[0].length;

      // 跳过代码块/数学块内的 native 标注
      if (this.isInFencedRange(fencedRanges, anchorStart, anchorEnd)) continue;
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
    // 🔧 P1-20 修复：检测重叠 region，使用 data-uuids 存储多个 UUID
    // 先收集所有 region 的内容范围
    const regionRanges: Array<{
      uuid: string;
      from: number;
      to: number;
      entry: { start: RegionAnchorMatch; end: RegionAnchorMatch };
    }> = [];
    for (const [uuid, entry] of regionByUuid.entries()) {
      if (!entry.start || !entry.end) continue;
      const contentStart = entry.start.index + entry.start.length;
      const contentEnd = entry.end.index;
      if (contentStart >= contentEnd) continue;
      regionRanges.push({ uuid, from: contentStart, to: contentEnd, entry });
    }

    // 按起始位置排序
    regionRanges.sort((a, b) => a.from - b.from || a.to - b.to);

    // 计算每个位置上重叠的 UUID 列表，将重叠的区段拆分为不重叠的子段
    const regionSegments = this.computeRegionSegments(regionRanges);

    for (const seg of regionSegments) {
      const classes = seg.uuids.map(u => {
        const e = regionByUuid.get(u);
        const color = e?.start?.color || 'yellow';
        return `markvault-region-edit-bg markvault-region-${color}`;
      }).join(' ');
      // 使用第一个 region 的颜色作为主色
      const firstEntry = regionByUuid.get(seg.uuids[0]);
      const primaryColor = firstEntry?.start?.color || 'yellow';

      decoItems.push({
        from: seg.from,
        to: seg.to,
        deco: Decoration.mark({
          class: `markvault-region-edit-bg markvault-region-${primaryColor}`,
          attributes: {
            'data-uuids': seg.uuids.join(','),
            'data-uuid': seg.uuids[0], // 向后兼容：保留第一个 UUID
            'data-kind': 'region',
          },
        }),
      });
    }

    // 块级内容（代码块/公式块）用左侧竖线标识，inline mark 覆盖不到 widget
    for (const rr of regionRanges) {
      try {
        const blockLines = this.findRegionBlockLines(view.state.doc, rr.from, rr.to);
        for (const line of blockLines) {
          decoItems.push({
            from: line.from,
            to: line.from,
            deco: Decoration.line({
              class: `markvault-region-block-line markvault-region-${rr.entry.start.color}`,
            }),
          });
        }
      } catch (err) {
        console.debug('MarkVault: region block line parse error', err);
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
   * 🔧 P1-20 修复：计算 region 的不重叠区段
   * 将可能重叠的 region 范围拆分为不重叠的子段，每个子段记录包含的 UUID 列表。
   * 这样重叠 region 的 data-uuids 属性能正确存储所有相关 UUID。
   */
  private computeRegionSegments(
    ranges: Array<{ uuid: string; from: number; to: number; entry: { start: RegionAnchorMatch; end: RegionAnchorMatch } }>,
  ): Array<{ from: number; to: number; uuids: string[] }> {
    if (ranges.length === 0) return [];
    if (ranges.length === 1) {
      return [{ from: ranges[0].from, to: ranges[0].to, uuids: [ranges[0].uuid] }];
    }

    // 收集所有边界点
    const points = new Set<number>();
    for (const r of ranges) {
      points.add(r.from);
      points.add(r.to);
    }
    const sorted = [...points].sort((a, b) => a - b);

    // 对每个子段，收集覆盖它的 UUID
    const segments: Array<{ from: number; to: number; uuids: string[] }> = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const segFrom = sorted[i];
      const segTo = sorted[i + 1];
      if (segFrom >= segTo) continue;

      const uuids: string[] = [];
      for (const r of ranges) {
        if (r.from <= segFrom && r.to >= segTo) {
          uuids.push(r.uuid);
        }
      }
      if (uuids.length > 0) {
        segments.push({ from: segFrom, to: segTo, uuids });
      }
    }

    // 合并相邻且 uuids 相同的段（减少 decoration 数量）
    const merged: Array<{ from: number; to: number; uuids: string[] }> = [];
    for (const seg of segments) {
      const key = seg.uuids.join(',');
      if (merged.length > 0) {
        const last = merged[merged.length - 1];
        if (last.to === seg.from && last.uuids.join(',') === key) {
          last.to = seg.to;
          continue;
        }
      }
      merged.push({ ...seg });
    }

    return merged;
  }

  /**
   * 找出 region 范围内属于代码块 / 公式块的行
   * 编辑模式下这些行是 CM6 widget，inline mark 覆盖不到，需要单独加行级标识。
   */
  /**
   * 🔧 P0-3 优化：限制 findRegionBlockLines 遍历范围
   * 先从文档开头扫描围栏状态（不收集结果），再仅在 region 范围内收集
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

    // 阶段1：从文档开头到 startLine-1，只追踪围栏状态
    for (let ln = 1; ln < startLine; ln++) {
      const trimmed = cmDoc.line(ln).text.trim();
      if (!inCodeBlock && !inMathBlock) {
        if (trimmed.startsWith('```')) inCodeBlock = true;
        else if (trimmed === '$$') inMathBlock = true;
      } else {
        if (inCodeBlock && trimmed.startsWith('```')) inCodeBlock = false;
        else if (inMathBlock && trimmed === '$$') inMathBlock = false;
      }
    }

    // 阶段2：仅在 region 范围内扫描并收集结果
    for (let ln = startLine; ln <= endLine; ln++) {
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

      if (inCodeBlock || inMathBlock) {
        result.push({ from: line.from });
      }
    }

    return result;
  }

  /**
   * 🔧 P0-8 修复：处理重叠标注
   * 策略：将重叠标注拆分为不重叠的区段，保留所有标注。
   * 外层标注被内层标注分割成 [前段] + [后段]，
   * 与内层标注重叠的区域降低 opacity (0.4) 以区分层级。
   *
   * CM6 RangeSetBuilder 不允许同位置 mark decoration 重叠，
   * 但拆分后的区段位置不重叠，可以正常添加。
   */
  private filterOverlapping(marks: Array<{
    openFrom: number; openTo: number; closeFrom: number; closeTo: number;
    uuid: string; type: AnnotationType; color: string; colorHex: string; note: string;
  }>): Array<{
    openFrom: number; openTo: number; closeFrom: number; closeTo: number;
    uuid: string; type: AnnotationType; color: string; colorHex: string; note: string;
    overlapOpacity?: number;
  }> {
    if (marks.length <= 1) return marks;

    // 按开始位置排序（已排序但防御性处理）
    const sorted = [...marks].sort((a, b) => a.openFrom - b.openFrom || a.closeTo - b.closeTo);

    // 结果数组：每个标注可能有多个不重叠的区段
    const result: Array<{
      openFrom: number; openTo: number; closeFrom: number; closeTo: number;
      uuid: string; type: AnnotationType; color: string; colorHex: string; note: string;
      overlapOpacity?: number;
    }> = [];

    // 跟踪已占用的范围栈
    const activeStack: Array<{
      openFrom: number; closeTo: number; uuid: string;
      type: AnnotationType; color: string; colorHex: string; note: string;
    }> = [];

    for (const mark of sorted) {
      // 找出与当前标注重叠的所有活跃标注
      const overlapping = activeStack.filter(
        a => mark.openFrom < a.closeTo && mark.closeTo > a.openFrom
      );

      if (overlapping.length === 0) {
        // 无重叠，直接添加
        result.push(mark);
        activeStack.push({
          openFrom: mark.openFrom, closeTo: mark.closeTo,
          uuid: mark.uuid, type: mark.type, color: mark.color,
          colorHex: mark.colorHex, note: mark.note,
        });
      } else {
        // 有重叠 — 当前标注作为更高层级(更晚创建)处理
        // 降低 opacity 表示重叠
        result.push({ ...mark, overlapOpacity: 0.4 });
        activeStack.push({
          openFrom: mark.openFrom, closeTo: mark.closeTo,
          uuid: mark.uuid, type: mark.type, color: mark.color,
          colorHex: mark.colorHex, note: mark.note,
        });
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
      } catch (err) {
        // 跳过解析失败的标签
        console.debug('MarkVault: failed to parse <mark> tag, skipping', err);
      }
    }

    return results;
  }

  /**
   * 🔧 P0-7: 预扫描文档中的代码块/数学块范围
   * 返回 [start, end) 偏移量数组，这些区域内的 inline 标注应被跳过。
   * 支持 ``` 代码块和 $$ 数学块。
   */
  private computeFencedRanges(doc: string): Array<{ from: number; to: number }> {
    const ranges: Array<{ from: number; to: number }> = [];
    const lines = doc.split('\n');
    let offset = 0;
    let inCodeBlock = false;
    let codeBlockStart = -1;
    let inMathBlock = false;
    let mathBlockStart = -1;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (!inCodeBlock && !inMathBlock) {
        if (trimmed.startsWith('```')) {
          inCodeBlock = true;
          codeBlockStart = offset;
        } else if (trimmed === '$$') {
          inMathBlock = true;
          mathBlockStart = offset;
        }
      } else if (inCodeBlock) {
        if (trimmed.startsWith('```')) {
          ranges.push({ from: codeBlockStart, to: offset + lines[i].length });
          inCodeBlock = false;
        }
      } else if (inMathBlock) {
        if (trimmed === '$$') {
          ranges.push({ from: mathBlockStart, to: offset + lines[i].length });
          inMathBlock = false;
        }
      }

      offset += lines[i].length + 1; // +1 for \n
    }

    // 未闭合的代码块/数学块也标记（到文档末尾）
    if (inCodeBlock) {
      ranges.push({ from: codeBlockStart, to: doc.length });
    }
    if (inMathBlock) {
      ranges.push({ from: mathBlockStart, to: doc.length });
    }

    return ranges;
  }

  /**
   * 🔧 P0-7: 检查 [checkFrom, checkTo] 是否与任何代码块/数学块范围重叠
   */
  private isInFencedRange(fencedRanges: Array<{ from: number; to: number }>, checkFrom: number, checkTo: number): boolean {
    for (const range of fencedRanges) {
      // 检查区间是否有重叠
      if (checkFrom < range.to && checkTo > range.from) {
        return true;
      }
    }
    return false;
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
