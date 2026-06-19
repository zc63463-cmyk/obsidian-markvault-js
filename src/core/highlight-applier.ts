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

import { EditorSelection, RangeSetBuilder, type Extension } from '@codemirror/state';
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
} from '@codemirror/view';
import { PRESET_COLORS, type AnnotationType } from '../types/annotation';
import { logger } from '../utils/logger';
import { findNativeWrapper, NATIVE_ANCHOR_REGEX } from './native-annotation';
import { REGION_ANCHOR_REGEX } from './region-annotation';
import { parseBlockAnchors, findBlockTargetLine, parseBlockDoubleAnchors } from './annotation-parser';

import {
  regionCacheUpdatedEffect,
  resolveFilePath,
  getFilePathFromView,
  getAnnotationClickHandler,
} from './editor-view-manager';
// Re-export for external consumers (main.ts, sync-engine.ts, cache-manager.ts)
export {
  setActiveEditorView,
  removeEditorView,
  clearActiveEditorViews,
  requestRegionLayerRedraw,
  setFilePathResolver,
  setAnnotationClickHandler,
  regionCacheUpdatedEffect,
} from './editor-view-manager';

// ─── Regex Patterns ──────────────────────────────────────
// 🔧 P1-D: MARK_FULL_REGEX / ATTR_EXTRACT_REGEX → decoration-helpers.ts
// 🔧 P1-D: BLOCK_ANCHOR_REGEX 未使用（block 隐藏用内联 test），已删除


// ─── 缓存层导入（从 annotation-cache.ts 提取）──────────────────
// 🔧 P0 修复: re-export 不创建本地绑定，本地调用的函数需要单独 import
import {
  getSpanCacheForFile,
  getBlockCacheForFile,
  getRegionCacheForFile,
} from './annotation-cache';

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

// 🔧 P1-D: 装饰辅助函数提取到 decoration-helpers.ts
import {
  getStyleForType,
  parseAttributes,
  parseMarkTags,
  filterOverlapping,
  computeFencedRanges,
  isInFencedRange,
  computeRegionSegments,
  findRegionBlockLines,
  type RegionAnchorMatch,
} from './decoration-helpers';

// ─── Widget Types 导入（从 highlight-widgets.ts 提取）──────
import {
  MarkOpenWidget,
  MarkCloseWidget,
  BlockAnchorWidget,
  NativeAnchorWidget,
  BlockBadgeWidget,
  RegionAnchorMarkerWidget,
} from './highlight-widgets';

// ─── ViewPlugin 实现 ─────────────────────────────────────

class MarkVaultDecorator implements PluginValue {
  decorations: DecorationSet;
  /** 🔧 P1-17 修复：编辑模式标注点击事件处理器引用（destroy 时清理） */
  private clickHandler: ((e: MouseEvent) => void) | null = null;
  /** 🔧 P1-21 修复：debounce 定时器，快速连续输入时合并重绘 */
  private _rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  /** 🔧 审查修复：保存 view 引用，destroy 时 removeEventListener */
  private _view: EditorView | null = null;

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
        const handler = getAnnotationClickHandler();
        if (uuid && handler) {
          e.preventDefault();
          e.stopPropagation();
          handler(uuid);
        }
      }
    };
    view.dom.addEventListener('click', this.clickHandler);
    this._view = view;
  }

  update(update: ViewUpdate) {
    if (update.docChanged) {
      // 外部文件修改（如 MindFlow saveFreeNodes）需立即重绘，
      // 否则旧 decorations 映射到新内容时可能跨越换行符
      this.decorations = this.buildDecorations(update.view);
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
    // 🔧 审查修复：先移除事件监听器再置空引用，避免 listener 泄漏
    if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
    if (this.clickHandler && this._view) {
      this._view.dom.removeEventListener('click', this.clickHandler);
    }
    this.clickHandler = null;
    this._view = null;
  }

  private buildDecorations(view: EditorView): DecorationSet {
    try {
      return this.buildDecorationsInner(view);
    } catch (err) {
      // 如果构建失败，返回空 DecorationSet，不能让整个 CM6 崩溃
      logger.error('MarkVault: buildDecorations error', err);
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
    const fencedRanges = computeFencedRanges(doc);

    // 收集所有装饰项
    const decoItems: { from: number; to: number; deco: Decoration }[] = [];

    // ── 1. 解析 <mark> 标签装饰 ──
    const marks = parseMarkTags(doc);
    // 🔧 P0-7 修复：过滤掉在代码块/数学块内的 <mark> 标签
    const safeMarks = marks.filter(m => !isInFencedRange(fencedRanges, m.openFrom, m.closeTo));
    const validMarks = filterOverlapping(safeMarks);

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
      let styleStr = getStyleForType(mark.type, mark.colorHex);
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
            const styleStr = getStyleForType(spanAnn.type, colorHex);
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
      if (isInFencedRange(fencedRanges, anchorStart, anchorEnd)) continue;
      const uuid = nativeMatch[1];
      const type = nativeMatch[2] as AnnotationType;
      const color = nativeMatch[3];

      const wrapper = findNativeWrapper(doc, anchorEnd, type);
      if (wrapper) {
        // 隐藏锚点（及锚点到 wrapper 之间的空白）
        // 🔧 P0 修复：Decoration.replace 不能跨越换行符
        const hideLineEnd = doc.indexOf('\n', anchorStart);
        const hideTo = (hideLineEnd !== -1 && hideLineEnd < wrapper.wrapperStart)
          ? hideLineEnd
          : wrapper.wrapperStart;
        if (anchorStart < hideTo) {
          decoItems.push({
            from: anchorStart,
            to: hideTo,
            deco: Decoration.replace({ widget: new NativeAnchorWidget(), block: false }),
          });
        }

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
    // 🔧 P1-D: RegionAnchorMatch 已从 decoration-helpers.ts 导入，不再重复定义
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
      const start = entry.start;
      const end = entry.end;
      if (!start || !end) continue;
      const contentStart = start.index + start.length;
      const contentEnd = end.index;
      if (contentStart >= contentEnd) continue;
      regionRanges.push({ uuid, from: contentStart, to: contentEnd, entry: { start, end } });
    }

    // 按起始位置排序
    regionRanges.sort((a, b) => a.from - b.from || a.to - b.to);

    // 计算每个位置上重叠的 UUID 列表，将重叠的区段拆分为不重叠的子段
    const regionSegments = computeRegionSegments(regionRanges);

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
        const blockLines = findRegionBlockLines(view.state.doc, rr.from, rr.to);
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
        logger.debug('MarkVault: region block line parse error', err);
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

      let { from, to } = item;

      // 🔧 P0 安全网：replace 装饰不能跨越换行符
      // CM6 规则：Decoration.replace 跨行会抛出
      // "Decorations that replace line breaks may not be specified via plugins"
      // replace 的 startSide > 0（exclusive start），mark/line/widget 的 startSide <= 0
      if (from < to && (item.deco as any).startSide > 0) {
        const lineEnd = doc.indexOf('\n', from);
        if (lineEnd !== -1 && lineEnd < to) {
          to = lineEnd;
          if (from >= to) continue;
        }
      }

      try {
        builder.add(from, to, item.deco);
        lastFrom = from;
      } catch (err) {
        // 跳过冲突的装饰
        logger.warn('MarkVault: decoration conflict at', from, err);
      }
    }

    return builder.finish();
  }

  // 🔧 P1-D: computeRegionSegments/findRegionBlockLines/filterOverlapping/parseMarkTags/computeFencedRanges/isInFencedRange/parseAttributes/getStyleForType
  // → extracted to decoration-helpers.ts
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
