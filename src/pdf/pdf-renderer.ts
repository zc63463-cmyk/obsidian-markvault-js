/**
 * PDFRenderer — PDF 标注渲染器
 *
 * 实现 AnnotationRenderer 接口，在 PDF viewer 上叠加 SVG overlay
 * 渲染高亮矩形。
 *
 * 渲染策略：
 * - 每个 PDF 页面上叠加一个 SVG layer
 * - 高亮矩形使用 PDF 坐标 → 屏幕坐标的反向转换
 * - 随页面滚动/缩放自动更新位置
 * - 点击高亮可触发标注编辑
 *
 * 生命周期：
 *   mount: 在 PDF viewer 容器上创建 SVG overlays
 *   update: 标注变更时增量更新 SVG 元素
 *   scrollToAnnotation: 翻页 + 滚动到高亮位置
 *   unmount: 移除所有 SVG overlays 和事件监听
 */

import type { App } from 'obsidian';
import { logger } from '../utils/logger';
import type { Annotation, DocType, PDFSelector, PDFRect, PercentRect } from '../types/annotation';
import { PRESET_COLORS } from '../types/annotation';
import type { AnnotationRenderer } from '../core/renderer';
import { getPDFViewerChild, getCurrentPage, getPDFPageCount, type PDFViewLike, type PDFViewportLike, type PDFPageViewLike } from './viewer-bridge';

// ─── 常量 ──────────────────────────────────────────────

const OVERLAY_CLASS = 'markvault-pdf-overlay';
const HIGHLIGHT_CLASS = 'markvault-pdf-highlight';
const HIGHLIGHT_ACTIVE_CLASS = 'markvault-pdf-highlight-active';

/** 高亮默认透明度 */
const HIGHLIGHT_OPACITY = 0.35;
/** 高亮活跃（闪烁）透明度 */
const HIGHLIGHT_ACTIVE_OPACITY = 0.6;

// ─── PDFRenderer ───────────────────────────────────────

export class PDFRenderer implements AnnotationRenderer {
  readonly docType: DocType = 'pdf';

  private app: App;
  private view: PDFViewLike | null = null;
  private container: HTMLElement | null = null;
  private annotations: Map<string, Annotation> = new Map();
  /** uuid → SVG rect element */
  private highlightElements: Map<string, SVGRectElement> = new Map();
  /** 页码 → SVG overlay element */
  private overlayByPage: Map<number, SVGSVGElement> = new Map();

  /** 滚动/缩放监听回调引用（用于清理） */
  private scrollHandler: (() => void) | null = null;
  private scrollContainer: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  /** rAF 防抖 ID — scroll/resize 时合并更新 */
  private _rafId: number | null = null;
  /** MutationObserver 防抖 timer */
  private _mutationDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App) {
    this.app = app;
  }

  // ═══════════════════════════════════════════════════════
  // AnnotationRenderer 接口实现
  // ═══════════════════════════════════════════════════════

  mount(container: HTMLElement, annotations: Annotation[]): void {
    this.container = container;
    this.view = container as unknown as PDFViewLike;

    // 初始化标注列表
    this.annotations.clear();
    for (const ann of annotations) {
      this.annotations.set(ann.uuid, ann);
    }

    logger.debug(`PDFRenderer: mounting with ${annotations.length} annotations`);

    // 渲染初始高亮
    this.renderAll();

    // 注册事件监听
    this.attachListeners();

    logger.debug('PDFRenderer: mount complete');
  }

  update(annotations: Annotation[]): void {
    // 构建新标注集合
    const newSet = new Map<string, Annotation>();
    for (const ann of annotations) {
      newSet.set(ann.uuid, ann);
    }

    // 移除已删除的标注
    for (const [uuid] of this.annotations) {
      if (!newSet.has(uuid)) {
        this.removeHighlight(uuid);
      }
    }

    // 添加/更新标注
    for (const [uuid, ann] of newSet) {
      const old = this.annotations.get(uuid);
      if (!old || this.annotationChanged(old, ann)) {
        this.removeHighlight(uuid);
        this.annotations.set(uuid, ann);
        this.renderHighlight(ann);
      }
    }

    // 同步标注集合
    this.annotations = newSet;
  }

  unmount(): void {
    this.detachListeners();

    // 移除所有 SVG overlays
    for (const [, overlay] of this.overlayByPage) {
      overlay.remove();
    }
    this.overlayByPage.clear();
    this.highlightElements.clear();
    this.annotations.clear();

    this.view = null;
    this.container = null;  // detachListeners 已保存了 scrollContainer 引用

    logger.debug('PDFRenderer: unmount complete');
  }

  scrollToAnnotation(uuid: string): void {
    const ann = this.annotations.get(uuid);
    if (!ann) {
      logger.debug(`PDFRenderer: annotation ${uuid} not found for scroll`);
      return;
    }

    const selector = ann.selector as PDFSelector | undefined;
    if (!selector) {
      logger.debug(`PDFRenderer: annotation ${uuid} has no PDF selector`);
      return;
    }

    const page = selector.page;
    const pageEl = this.getPageElement(page);
    if (!pageEl) {
      logger.debug(`PDFRenderer: page ${page} element not found`);
      return;
    }

    // 滚动到页面
    pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // 高亮闪烁
    this.flashHighlight(uuid);
  }

  getRenderedCount(): number {
    return this.highlightElements.size;
  }

  // ═══════════════════════════════════════════════════════
  // 渲染逻辑
  // ═══════════════════════════════════════════════════════

  /** 渲染所有标注 */
  private renderAll(): void {
    for (const [, ann] of this.annotations) {
      this.renderHighlight(ann);
    }
  }

  /** 渲染单个标注的高亮 */
  private renderHighlight(ann: Annotation): void {
    const selector = ann.selector as PDFSelector | undefined;
    if (!selector || selector.type !== 'pdf') {
      return;
    }

    const overlay = this.getOrCreateOverlay(selector.page);
    if (!overlay) {
      logger.debug(`PDFRenderer: cannot create overlay for page ${selector.page}`);
      return;
    }

    // 优先使用百分比坐标（缩放时零计算自动适配）
    if (selector.percentRects && selector.percentRects.length > 0) {
      this.renderWithPercentRects(overlay, ann, selector.percentRects);
    } else {
      // Fallback: 绝对坐标转换（旧数据兼容）
      const viewport = this.getPageViewport(selector.page);
      const pageEl = this.getPageElement(selector.page);
      if (!pageEl) return;
      const pageRect = pageEl.getBoundingClientRect();
      this.renderWithAbsoluteRects(overlay, ann, selector.rects, viewport, pageRect);
    }
  }

  /** 用百分比坐标渲染 — SVG rect 属性设为百分比值 */
  private renderWithPercentRects(
    overlay: SVGSVGElement,
    ann: Annotation,
    percentRects: PercentRect[],
  ): void {
    for (const pr of percentRects) {
      const rectEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      // 百分比属性 — 缩放时自动跟随容器尺寸
      rectEl.setAttribute('x', `${pr.x}%`);
      rectEl.setAttribute('y', `${pr.y}%`);
      rectEl.setAttribute('width', `${pr.width}%`);
      rectEl.setAttribute('height', `${pr.height}%`);
      rectEl.setAttribute('fill', this.getColorHex(ann.color));
      rectEl.setAttribute('opacity', String(HIGHLIGHT_OPACITY));
      rectEl.setAttribute('rx', '2');
      rectEl.classList.add(HIGHLIGHT_CLASS);
      rectEl.dataset.uuid = ann.uuid;

      rectEl.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.onHighlightClick(ann.uuid);
      });

      overlay.appendChild(rectEl);

      if (!this.highlightElements.has(ann.uuid)) {
        this.highlightElements.set(ann.uuid, rectEl);
      }
    }
  }

  /** 用绝对坐标渲染（旧数据兼容 fallback） */
  private renderWithAbsoluteRects(
    overlay: SVGSVGElement,
    ann: Annotation,
    rects: PDFRect[],
    viewport: PDFViewportLike | null,
    pageRect: DOMRect,
  ): void {
    for (const pdfRect of rects) {
      const screenCoords = this.pdfRectToScreen(pdfRect, viewport, pageRect);
      if (!screenCoords) continue;

      const rectEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rectEl.setAttribute('x', String(screenCoords.x));
      rectEl.setAttribute('y', String(screenCoords.y));
      rectEl.setAttribute('width', String(screenCoords.width));
      rectEl.setAttribute('height', String(screenCoords.height));
      rectEl.setAttribute('fill', this.getColorHex(ann.color));
      rectEl.setAttribute('opacity', String(HIGHLIGHT_OPACITY));
      rectEl.setAttribute('rx', '2');
      rectEl.classList.add(HIGHLIGHT_CLASS);
      rectEl.dataset.uuid = ann.uuid;

      rectEl.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.onHighlightClick(ann.uuid);
      });

      overlay.appendChild(rectEl);

      if (!this.highlightElements.has(ann.uuid)) {
        this.highlightElements.set(ann.uuid, rectEl);
      }
    }
  }

  /** 移除单个标注的高亮 */
  private removeHighlight(uuid: string): void {
    // 移除所有该 uuid 的 SVG 元素
    for (const [, overlay] of this.overlayByPage) {
      const elements = overlay.querySelectorAll(`[data-uuid="${uuid}"]`);
      elements.forEach(el => el.remove());
    }
    this.highlightElements.delete(uuid);
  }

  /** 高亮闪烁效果 */
  private flashHighlight(uuid: string): void {
    const el = this.highlightElements.get(uuid);
    if (!el) return;

    el.classList.add(HIGHLIGHT_ACTIVE_CLASS);
    el.setAttribute('opacity', String(HIGHLIGHT_ACTIVE_OPACITY));

    setTimeout(() => {
      el.classList.remove(HIGHLIGHT_ACTIVE_CLASS);
      el.setAttribute('opacity', String(HIGHLIGHT_OPACITY));
    }, 1500);
  }

  // ═══════════════════════════════════════════════════════
  // 坐标转换
  // ═══════════════════════════════════════════════════════

  /**
   * PDF 坐标 → 屏幕坐标转换。
   *
   * PDF 坐标系: 左下原点，y 向上
   * 屏幕坐标系: 左上原点，y 向下
   *
   * 如果有 viewport.transform，使用矩阵变换（最精确）。
   * 否则手动翻转 Y 轴并乘以 scale。
   */
  private pdfRectToScreen(
    pdfRect: PDFRect,
    viewport: PDFViewportLike | null,
    pageRect: DOMRect,
  ): { x: number; y: number; width: number; height: number } | null {
    if (!viewport) {
      // Fallback: 假设 PDF 坐标 = 屏幕坐标（仅当 scale=1 且坐标系一致时）
      return {
        x: pdfRect.x1,
        y: pageRect.height - pdfRect.y2,
        width: pdfRect.x2 - pdfRect.x1,
        height: pdfRect.y2 - pdfRect.y1,
      };
    }

    const scale = viewport.scale || 1;

    // 如果有 transform 矩阵，使用它
    if (viewport.transform && viewport.transform.length >= 6) {
      const t = viewport.transform;
      // PDF.js transform: [a, b, c, d, e, f]
      // screenX = a * pdfX + c * pdfY + e
      // screenY = b * pdfX + d * pdfY + f
      const x1 = t[0] * pdfRect.x1 + t[2] * pdfRect.y2 + t[4];
      const y1 = t[1] * pdfRect.x1 + t[3] * pdfRect.y2 + t[5];
      const x2 = t[0] * pdfRect.x2 + t[2] * pdfRect.y1 + t[4];
      const y2 = t[1] * pdfRect.x2 + t[3] * pdfRect.y1 + t[5];

      return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      };
    }

    // 手动转换
    const x = pdfRect.x1 * scale;
    const width = (pdfRect.x2 - pdfRect.x1) * scale;
    // Y 轴翻转: pdfY2 (上方) → screenY (上方)
    const y = (viewport.height - pdfRect.y2) * scale;
    const height = (pdfRect.y2 - pdfRect.y1) * scale;

    return { x, y, width, height };
  }

  // ═══════════════════════════════════════════════════════
  // Overlay 管理
  // ═══════════════════════════════════════════════════════

  /** 获取或创建指定页面的 SVG overlay */
  private getOrCreateOverlay(page: number): SVGSVGElement | null {
    // 检查缓存
    const cached = this.overlayByPage.get(page);
    if (cached && cached.isConnected) {
      return cached;
    }

    const pageEl = this.getPageElement(page);
    if (!pageEl) return null;

    const pageRect = pageEl.getBoundingClientRect();

    // 创建 SVG overlay
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add(OVERLAY_CLASS);
    svg.setAttribute('width', String(pageRect.width));
    svg.setAttribute('height', String(pageRect.height));
    svg.style.position = 'absolute';
    svg.style.left = '0';
    svg.style.top = '0';
    svg.style.pointerEvents = 'auto';
    svg.style.zIndex = '1';
    svg.style.mixBlendMode = 'multiply';

    // 将 overlay 插入到页面容器内
    // PDF.js 页面容器通常是 position: relative
    if (getComputedStyle(pageEl).position === 'static') {
      pageEl.style.position = 'relative';
    }
    pageEl.appendChild(svg);

    this.overlayByPage.set(page, svg);
    return svg;
  }

  /** 获取指定页码的 DOM 元素 */
  private getPageElement(page: number): HTMLElement | null {
    if (!this.container) return null;

    // PDF.js 页面元素有 data-page-number 属性 (1-indexed)
    const selector = `[data-page-number="${page + 1}"], [data-page-index="${page}"]`;
    const el = this.container.querySelector(selector) as HTMLElement | null;
    if (el) return el;

    // Fallback: 通过 class 查找
    const pageEls = this.container.querySelectorAll('.page');
    if (pageEls.length > page) {
      return pageEls[page] as HTMLElement;
    }

    return null;
  }

  /** 获取指定页面的 viewport */
  private getPageViewport(page: number): PDFViewportLike | null {
    if (!this.view) return null;

    const child = getPDFViewerChild(this.view);
    if (!child) return null;

    let pageView: PDFPageViewLike | undefined;

    if (child.getPage) {
      pageView = child.getPage(page + 1);
    }
    if (!pageView && child.pageMap) {
      pageView = child.pageMap.get(page + 1) ?? child.pageMap.get(page);
    }
    if (!pageView && child.pdfViewer?._pages) {
      pageView = child.pdfViewer._pages[page];
    }

    if (pageView?.viewport) {
      return pageView.viewport;
    }
    if (pageView?.pdfPage) {
      try {
        return pageView.pdfPage.getViewport({ scale: 1 });
      } catch {
        try {
          return pageView.pdfPage.getViewport();
        } catch {
          // fall through
        }
      }
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════
  // 事件监听
  // ═══════════════════════════════════════════════════════

  /** 注册事件监听器 */
  private attachListeners(): void {
    if (!this.container) return;

    // 滚动监听：用 rAF 防抖合并更新（避免频繁 scroll 事件卡顿）
    this.scrollHandler = () => {
      this.scheduleUpdate();
    };

    this.scrollContainer = this.container.closest('.view-content') as HTMLElement || this.container;
    this.scrollContainer.addEventListener('scroll', this.scrollHandler, { passive: true });

    // ResizeObserver: 页面尺寸变化时更新 overlay
    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleUpdate();
    });
    this.resizeObserver.observe(this.container);

    // MutationObserver: PDF.js 动态创建页面元素时重新渲染
    // ⚠️ 关键: 加防抖 + 忽略自身 DOM 变更，避免无限循环
    // （renderAll → appendChild → mutation → renderAll → ...）
    this.mutationObserver = new MutationObserver((mutations) => {
      // 过滤掉由自身 overlay 引起的变更
      const hasExternalMutation = mutations.some(m => {
        for (const node of Array.from(m.addedNodes)) {
          if (node instanceof Element && !node.classList?.contains(OVERLAY_CLASS) && !node.classList?.contains(HIGHLIGHT_CLASS)) {
            return true;
          }
        }
        return false;
      });

      if (!hasExternalMutation) return;

      // 防抖: 300ms 内只触发一次重渲染
      if (this._mutationDebounce) clearTimeout(this._mutationDebounce);
      this._mutationDebounce = setTimeout(() => {
        this.renderAll();
        this._mutationDebounce = null;
      }, 300);
    });
    this.mutationObserver.observe(this.container, {
      childList: true,
      subtree: true,
    });
  }

  /** 注销事件监听器 */
  private detachListeners(): void {
    // ⚠️ 修复: 使用保存的 scrollContainer 引用，而非 this.container（此时可能已 null）
    if (this.scrollHandler && this.scrollContainer) {
      this.scrollContainer.removeEventListener('scroll', this.scrollHandler);
      this.scrollHandler = null;
      this.scrollContainer = null;
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }

    // 清理防抖 timer
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._mutationDebounce) {
      clearTimeout(this._mutationDebounce);
      this._mutationDebounce = null;
    }
  }

  /** 用 rAF 防抖调度 overlay 位置更新 */
  private scheduleUpdate(): void {
    if (this._rafId !== null) return; // 已有待执行的更新
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this.updateOverlayPositions();
    });
  }

  /**
   * 更新所有 overlay 的位置和尺寸。
   *
   * 百分比坐标模式（优先）：只需更新 overlay 容器的 width/height，
   * SVG rect 用百分比属性自动跟随缩放，O(pages) 零 rect 计算。
   *
   * 绝对坐标模式（旧数据 fallback）：需要逐个重算每个 rect 的屏幕坐标。
   */
  private updateOverlayPositions(): void {
    let needsAbsoluteUpdate = false;

    for (const [page, overlay] of this.overlayByPage) {
      if (!overlay.isConnected) {
        this.overlayByPage.delete(page);
        continue;
      }

      const pageEl = this.getPageElement(page);
      if (!pageEl) continue;

      const pageRect = pageEl.getBoundingClientRect();
      // 更新 overlay 容器尺寸 — 百分比 rect 自动跟随
      overlay.setAttribute('width', String(pageRect.width));
      overlay.setAttribute('height', String(pageRect.height));
    }

    // 只在有旧数据（无 percentRects）时才逐个重算
    for (const [, ann] of this.annotations) {
      const selector = ann.selector as PDFSelector | undefined;
      if (!selector) continue;
      // 有 percentRects 的标注不需要重算
      if (selector.percentRects && selector.percentRects.length > 0) continue;

      needsAbsoluteUpdate = true;
      break;
    }

    if (!needsAbsoluteUpdate) return;

    // 绝对坐标 fallback：逐个重算
    for (const [uuid, ann] of this.annotations) {
      const selector = ann.selector as PDFSelector | undefined;
      if (!selector) continue;
      if (selector.percentRects && selector.percentRects.length > 0) continue;

      const viewport = this.getPageViewport(selector.page);
      const pageEl = this.getPageElement(selector.page);
      if (!pageEl) continue;

      const pageRect = pageEl.getBoundingClientRect();
      const overlay = this.overlayByPage.get(selector.page);
      if (!overlay) continue;

      const rectEls = overlay.querySelectorAll(`[data-uuid="${uuid}"]`);
      for (let i = 0; i < rectEls.length && i < selector.rects.length; i++) {
        const rectEl = rectEls[i] as SVGRectElement;
        const screenCoords = this.pdfRectToScreen(selector.rects[i], viewport, pageRect);
        if (screenCoords) {
          rectEl.setAttribute('x', String(screenCoords.x));
          rectEl.setAttribute('y', String(screenCoords.y));
          rectEl.setAttribute('width', String(screenCoords.width));
          rectEl.setAttribute('height', String(screenCoords.height));
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // 工具方法
  // ═══════════════════════════════════════════════════════

  /** 判断标注是否发生变化 */
  private annotationChanged(old: Annotation, neu: Annotation): boolean {
    if (old.updatedAt !== neu.updatedAt) return true;
    if (old.color !== neu.color) return true;
    if (old.note !== neu.note) return true;

    const oldSel = old.selector as PDFSelector | undefined;
    const newSel = neu.selector as PDFSelector | undefined;
    if (!oldSel || !newSel) return true;
    if (oldSel.page !== newSel.page) return true;
    if (oldSel.rects.length !== newSel.rects.length) return true;

    // percentRects 变更检测
    const oldPR = oldSel.percentRects;
    const newPR = newSel.percentRects;
    if (!oldPR !== !newPR) return true; // 一个有一个没有
    if (oldPR && newPR && oldPR.length !== newPR.length) return true;
    if (oldPR && newPR) {
      for (let i = 0; i < oldPR.length; i++) {
        if (oldPR[i].x !== newPR[i].x || oldPR[i].y !== newPR[i].y ||
            oldPR[i].width !== newPR[i].width || oldPR[i].height !== newPR[i].height) {
          return true;
        }
      }
    }

    return oldSel.rects.some((r, i) => {
      const r2 = newSel.rects[i];
      return r.x1 !== r2.x1 || r.y1 !== r2.y1 || r.x2 !== r2.x2 || r.y2 !== r2.y2;
    });
  }

  /** 获取颜色的 hex 值 — 复用全局 PRESET_COLORS，避免硬编码重复 */
  private getColorHex(color: string): string {
    const preset = PRESET_COLORS.find(c => c.id === color);
    if (preset) return preset.hex;

    // 如果已经是 hex 格式，直接返回
    if (color.startsWith('#')) return color;

    // 默认黄色
    return '#FACC15';
  }

  /** 高亮点击回调（由外部设置） */
  private _clickHandler: ((uuid: string) => void) | null = null;

  /** 设置高亮点击回调 */
  setClickHandler(handler: (uuid: string) => void): void {
    this._clickHandler = handler;
  }

  /** 高亮点击事件处理 */
  private onHighlightClick(uuid: string): void {
    if (this._clickHandler) {
      this._clickHandler(uuid);
    }
  }
}
