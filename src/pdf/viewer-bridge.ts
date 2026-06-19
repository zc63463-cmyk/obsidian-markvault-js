/**
 * PDFViewerBridge — Obsidian PDF.js 查看器桥接层
 *
 * 职责：
 * 1. 防御性访问 Obsidian 私有 PDFViewerChild API
 * 2. 从 textLayer 选区提取 PDFRect[] 坐标
 * 3. 坐标系转换：屏幕坐标（左上原点）→ PDF 坐标（左下原点）
 *
 * ⚠️ PDFViewerChild 是 Obsidian 私有 API，可能随版本变化。
 *    所有访问都做防御性检查，失败时优雅降级。
 *
 * 坐标系统说明：
 * - PDF.js 渲染使用屏幕坐标系（左上角为原点，y 向下）
 * - PDFRect 使用 PDF 坐标系（左下角为原点，y 向上）
 * - 转换公式：pdfY = pageHeight - screenY
 * - pageHeight 通过 PDF.js viewport 获取，或从 DOM 推断
 */

import type { App, WorkspaceLeaf } from 'obsidian';
import { logger } from '../utils/logger';
import type { PDFRect, PercentRect } from '../types/annotation';

// ─── 类型定义（私有 API 鸭子类型） ─────────────────────

/**
 * Obsidian PDFView 的鸭子类型接口。
 * 这些属性不在公开 API 中，通过运行时检查访问。
 */
export interface PDFViewLike {
  getViewType(): string;
  file: { path: string } | null;
  containerEl: HTMLElement;
  /** Obsidian 内部: PDFViewerChild 实例 */
  viewer?: PDFViewerChildLike;
  /** Obsidian 内部: PDF.js viewer 实例（部分版本） */
  pdfViewer?: PDFJSViewerLike;
}

/**
 * PDFViewerChild 鸭子类型 — Obsidian 内部类
 */
interface PDFViewerChildLike {
  /** PDF.js viewer 实例 */
  pdfViewer?: PDFJSViewerLike;
  /** 页码 → 页面视图的映射 */
  pageMap?: Map<number, PDFPageViewLike>;
  /** 获取指定页码的页面视图 */
  getPage?(pageNum: number): PDFPageViewLike | undefined;
  /** PDF.js 当前页面 */
  currentPage?: number;
}

/**
 * PDF.js Viewer 鸭子类型
 */
interface PDFJSViewerLike {
  /** 当前页码 (0-indexed) */
  currentPageNumber?: number;
  /** 总页数 */
  pagesCount?: number;
  /** 页面视图数组 */
  _pages?: PDFPageViewLike[];
  /** 获取页面视图 */
  getPageView?(pageNum: number): PDFPageViewLike | undefined;
}

/**
 * PDF.js PageView 鸭子类型
 */
export interface PDFPageViewLike {
  /** 页码 (0-indexed) */
  id?: number;
  /** 页面视口（含缩放信息） */
  viewport?: PDFViewportLike;
  /** 页面 DOM 元素 */
  div?: HTMLElement;
  /** PDF.js 页面对象 */
  pdfPage?: {
    getViewport(params: { scale: number }): PDFViewportLike;
    getViewport(): PDFViewportLike;
  };
}

/**
 * PDF.js Viewport 鸭子类型
 */
export interface PDFViewportLike {
  /** 页面宽度（CSS 像素） */
  width: number;
  /** 页面高度（CSS 像素） */
  height: number;
  /** 缩放比例 */
  scale: number;
  /** 将屏幕坐标转换为 PDF 坐标 [x, y] → [pdfX, pdfY] */
  convertToPDFPoint?(x: number, y: number): number[];
  /** 变换矩阵 */
  transform?: number[];
}

// ─── 桥接 API ──────────────────────────────────────────

/**
 * 检查当前活跃视图是否为 PDF 视图。
 */
export function getActivePDFView(app: App): PDFViewLike | null {
  const leaf = app.workspace.activeLeaf;
  if (!leaf) return null;
  const view = leaf.view as unknown as { getViewType?: () => string } | undefined;
  if (!view || typeof view.getViewType !== 'function' || view.getViewType() !== 'pdf') {
    return null;
  }
  // 强制类型断言为 PDFViewLike
  const pdfView = leaf.view as unknown as PDFViewLike;
  if (!pdfView.containerEl) return null;
  return pdfView;
}

/**
 * 检查 WorkspaceLeaf 是否为 PDF 视图。
 */
export function isPDFLeaf(leaf: WorkspaceLeaf): boolean {
  try {
    const view = leaf.view as unknown as { getViewType?: () => string };
    return typeof view.getViewType === 'function' && view.getViewType() === 'pdf';
  } catch {
    return false;
  }
}

/**
 * 从 WorkspaceLeaf 获取 PDFView（如果它是 PDF 视图）。
 */
export function getPDFFromLeaf(leaf: WorkspaceLeaf): PDFViewLike | null {
  if (!isPDFLeaf(leaf)) return null;
  return leaf.view as unknown as PDFViewLike;
}

/**
 * 获取 PDFViewerChild 实例（防御性访问私有 API）。
 *
 * 尝试多种访问路径，兼容不同 Obsidian 版本：
 * 1. view.viewer (新版)
 * 2. view.pdfViewer (部分版本直接暴露)
 * 3. 从 DOM 推断（fallback）
 */
export function getPDFViewerChild(view: PDFViewLike): PDFViewerChildLike | null {
  // 路径1: view.viewer
  if (view.viewer && (view.viewer.pdfViewer || view.viewer.pageMap)) {
    return view.viewer;
  }

  // 路径2: view.pdfViewer
  if (view.pdfViewer) {
    return { pdfViewer: view.pdfViewer };
  }

  // 路径3: 从 DOM 查找 PDF.js viewer 容器
  const viewerEl = view.containerEl.querySelector('.pdf-viewer, [data-view="pdf"]');
  if (viewerEl) {
    logger.debug('PDFViewerBridge: accessed via DOM fallback (private API unavailable)');
    // 返回一个最小可用对象，后续从 DOM 获取信息
    return { currentPage: 0 };
  }

  logger.debug('PDFViewerBridge: no PDF viewer found');
  return null;
}

// ─── 选区提取 ──────────────────────────────────────────

/**
 * 从当前 DOM 选区提取 PDF 标注信息。
 *
 * 流程：
 * 1. 获取 window.getSelection()
 * 2. 检查选区是否在 PDF textLayer 内
 * 3. 找到选区所在的页码
 * 4. 将选区的 DOM Range rects 转换为 PDFRect[]
 *
 * @returns PDF 选区信息，如果选区不在 PDF 内或为空则返回 null
 */
export interface PDFSelectionResult {
  /** 页码 (0-indexed) */
  page: number;
  /** PDF 绝对坐标系矩形数组（W3C 兼容导出用） */
  rects: PDFRect[];
  /** 百分比坐标矩形数组（渲染用，缩放时零计算适配） */
  percentRects: PercentRect[];
  /** 选区文本内容（用于 textHash） */
  text: string;
}

export function getPDFSelection(view: PDFViewLike): PDFSelectionResult | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const text = selection.toString();
  if (!text.trim()) {
    return null;
  }

  // 找到选区所在的 PDF 页面元素
  const pageEl = findPageElement(range.commonAncestorContainer);
  if (!pageEl) {
    logger.debug('PDFViewerBridge: selection not inside a PDF page');
    return null;
  }

  const pageNum = parseInt(pageEl.dataset.pageNumber || pageEl.getAttribute('data-page-number') || '1', 10) - 1;
  if (isNaN(pageNum) || pageNum < 0) {
    logger.debug(`PDFViewerBridge: invalid page number from element: ${pageEl.dataset.pageNumber}`);
    return null;
  }

  // 获取页面视口用于坐标转换
  const viewport = getPageViewport(view, pageNum, pageEl);
  const pageRect = pageEl.getBoundingClientRect();
  const rects = rangeRectsToPDFRects(range, pageEl, viewport);
  const percentRects = rangeRectsToPercentRects(range, pageRect);

  if (rects.length === 0) {
    logger.debug('PDFViewerBridge: no valid rects extracted from selection');
    return null;
  }

  return { page: pageNum, rects, percentRects, text };
}

/**
 * 从选区的起始节点向上查找 PDF 页面元素。
 *
 * PDF.js 渲染的页面容器有 `data-page-number` 属性和 `page` class。
 */
function findPageElement(node: Node): HTMLElement | null {
  let el: Element | null = node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;

  while (el) {
    // PDF.js 页面容器特征
    if (
      el.hasAttribute('data-page-number') ||
      el.classList.contains('page') ||
      el.hasAttribute('data-page-index')
    ) {
      // 确保是 PDF.js 的页面元素，而不是其他 .page 元素
      const parent = el.parentElement;
      if (parent && (parent.classList.contains('pdf-viewer') || parent.classList.contains('pdfViewer'))) {
        return el as HTMLElement;
      }
      // 也接受直接在 PDF 容器内的 .page
      if (el.classList.contains('page') && el.hasAttribute('data-page-number')) {
        return el as HTMLElement;
      }
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * 获取指定页面的 PDF.js viewport。
 *
 * 优先从 PDFViewerChild API 获取，fallback 到 DOM 尺寸推断。
 */
function getPageViewport(
  view: PDFViewLike,
  pageNum: number,
  pageEl: HTMLElement,
): PDFViewportLike | null {
  const child = getPDFViewerChild(view);

  // 路径1: 通过 PDFViewerChild.pageMap / getPage
  if (child) {
    let pageView: PDFPageViewLike | undefined;

    if (child.getPage) {
      pageView = child.getPage(pageNum + 1); // PDFViewerChild 可能用 1-indexed
    }
    if (!pageView && child.pageMap) {
      pageView = child.pageMap.get(pageNum + 1) ?? child.pageMap.get(pageNum);
    }
    if (!pageView && child.pdfViewer?._pages) {
      pageView = child.pdfViewer._pages[pageNum];
    }
    if (!pageView && child.pdfViewer?.getPageView) {
      pageView = child.pdfViewer.getPageView(pageNum);
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
  }

  // 路径2: 从 DOM 推断（fallback，精度较低）
  const rect = pageEl.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    logger.debug(`PDFViewerBridge: using DOM fallback viewport for page ${pageNum}`);
    return {
      width: rect.width,
      height: rect.height,
      scale: 1,
    };
  }

  return null;
}

/**
 * 将 DOM Range 的 rects 转换为 PDFRect[]。
 *
 * 坐标转换：
 * - DOM rect 是相对于视口的，需先减去 pageEl 的偏移得到页面内坐标
 * - 然后从屏幕坐标（左上原点）转换为 PDF 坐标（左下原点）
 * - pdfY = pageHeight - screenY
 */
function rangeRectsToPDFRects(
  range: Range,
  pageEl: HTMLElement,
  viewport: PDFViewportLike | null,
): PDFRect[] {
  const pageRect = pageEl.getBoundingClientRect();
  // ⚠️ 修复: 统一使用 viewport.height（PDF 原始尺寸），而非 pageRect.height（屏幕渲染尺寸）
  // 缩放时 pageRect.height = viewport.height * scale，两者不同
  const pageHeight = viewport?.height ?? pageRect.height;
  const scale = viewport?.scale ?? 1;

  const domRects = range.getClientRects();
  const pdfRects: PDFRect[] = [];

  for (let i = 0; i < domRects.length; i++) {
    const dr = domRects[i];

    // 跳过无效矩形
    if (dr.width <= 0 || dr.height <= 0) continue;

    // 相对于页面元素的坐标（屏幕坐标系）
    const relX = dr.left - pageRect.left;
    const relY = dr.top - pageRect.top;

    // 如果有 viewport.convertToPDFPoint，使用它（最精确）
    if (viewport?.convertToPDFPoint) {
      try {
        // convertToPDFPoint 接受屏幕坐标（相对于 viewport）
        // 左下角
        const [x1, y1] = viewport.convertToPDFPoint(relX, relY + dr.height);
        // 右上角
        const [x2, y2] = viewport.convertToPDFPoint(relX + dr.width, relY);
        pdfRects.push({ x1, y1, x2, y2 });
        continue;
      } catch {
        // fall through to manual conversion
      }
    }

    // 手动转换：屏幕坐标 → PDF 坐标
    // 1. 除以 scale 得到 PDF 原始坐标
    // 2. Y 轴翻转: pdfY = pageHeight - screenY
    // ⚠️ 修复: 使用 pageHeight（viewport.height）而非 pageRect.height
    const pdfX1 = relX / scale;
    const pdfY2 = (pageHeight - relY) / scale; // top → PDF y
    const pdfX2 = (relX + dr.width) / scale;
    const pdfY1 = (pageHeight - relY - dr.height) / scale; // bottom → PDF y

    pdfRects.push({ x1: pdfX1, y1: pdfY1, x2: pdfX2, y2: pdfY2 });
  }

  // 合并相邻的同 y 范围矩形（减少冗余）
  return mergeAdjacentRects(pdfRects);
}

/**
 * 将 DOM Range 的 rects 转换为百分比矩形数组。
 *
 * 百分比相对于页面元素的渲染尺寸（pageRect），与缩放比例无关：
 *   percentX = (domRect.left - pageRect.left) / pageRect.width * 100
 *   percentY = (domRect.top - pageRect.top) / pageRect.height * 100
 *
 * 优势：SVG rect 用百分比属性后，缩放时只需更新容器尺寸，
 * rect 自动按比例缩放，零计算开销。
 */
function rangeRectsToPercentRects(range: Range, pageRect: DOMRect): PercentRect[] {
  if (pageRect.width <= 0 || pageRect.height <= 0) return [];

  const domRects = range.getClientRects();
  const percentRects: PercentRect[] = [];

  for (let i = 0; i < domRects.length; i++) {
    const dr = domRects[i];
    if (dr.width <= 0 || dr.height <= 0) continue;

    const relX = dr.left - pageRect.left;
    const relY = dr.top - pageRect.top;

    percentRects.push({
      x: (relX / pageRect.width) * 100,
      y: (relY / pageRect.height) * 100,
      width: (dr.width / pageRect.width) * 100,
      height: (dr.height / pageRect.height) * 100,
    });
  }

  return percentRects;
}

/**
 * 合并 y 范围相同且 x 相邻的矩形，减少冗余。
 */
function mergeAdjacentRects(rects: PDFRect[]): PDFRect[] {
  if (rects.length <= 1) return rects;

  // 按 y1 降序（从上到下），再按 x1 升序排序
  const sorted = [...rects].sort((a, b) => {
    if (Math.abs(a.y1 - b.y1) > 1) return b.y1 - a.y1; // y1 大的在前（上方）
    return a.x1 - b.x1;
  });

  const merged: PDFRect[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.y1 - r.y1) < 1 && Math.abs(last.y2 - r.y2) < 1 && r.x1 <= last.x2 + 1) {
      // 合并
      last.x2 = Math.max(last.x2, r.x2);
    } else {
      merged.push({ ...r });
    }
  }

  return merged;
}

// ─── 工具函数 ──────────────────────────────────────────

/**
 * 计算选区文本的简单哈希（用于 textHash 字段，漂移恢复）。
 */
export function computeTextHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // 转为 32bit 整数
  }
  return `h${Math.abs(hash).toString(36)}`;
}

/**
 * 获取 PDF 文件的总页数。
 */
export function getPDFPageCount(view: PDFViewLike): number {
  const child = getPDFViewerChild(view);
  if (child?.pdfViewer?.pagesCount) {
    return child.pdfViewer.pagesCount;
  }
  // Fallback: 数 DOM 中的页面元素
  const pageEls = view.containerEl.querySelectorAll('[data-page-number]');
  return pageEls.length;
}

/**
 * 获取当前显示的页码 (0-indexed)。
 */
export function getCurrentPage(view: PDFViewLike): number {
  const child = getPDFViewerChild(view);
  if (child?.pdfViewer?.currentPageNumber !== undefined) {
    return child.pdfViewer.currentPageNumber - 1; // PDF.js 用 1-indexed
  }
  if (child?.currentPage !== undefined) {
    return child.currentPage;
  }
  // Fallback: 找视口中可见的页面
  const pageEls = view.containerEl.querySelectorAll('[data-page-number]');
  for (const el of Array.from(pageEls)) {
    const rect = el.getBoundingClientRect();
    if (rect.top >= 0 && rect.bottom <= window.innerHeight) {
      return parseInt(el.getAttribute('data-page-number') || '1', 10) - 1;
    }
  }
  return 0;
}
