/**
 * Mermaid 全屏预览浮层 — V4 PanZoom 实现
 *
 * 🔧 Phase 5B P1-F: 从 annotation-modal.ts 提取 (~440 行)
 *
 * 核心架构 (viewport + canvas 双层):
 *   viewport: overflow:hidden 容器，拦截所有输入事件
 *   canvas:   CSS transform 双重变换 translate(panX, panY) scale(zoom)
 *
 * 关键改进 (vs V3):
 *   1. 动态 transition 管理 — 拖拽/滚轮时禁用，按钮/双击/重置时启用
 *   2. requestAnimationFrame 节流 — wheel/mousemove 不再直写 DOM，合并到下一帧
 *   3. 正确的事件监听器生命周期 — mousedown 时注册 document mousemove/mouseup，
 *      mouseup 时注销
 *   4. 指数缩放 — wheel 使用乘法因子而非加法，更自然 (参考 anvaka/panzoom)
 *   5. fitScale 计算时序 — 双重 rAF + SVG viewBox 回退
 *   6. 完整清理 — close 时移除所有监听器，无内存泄漏
 *
 * @module mermaid-preview-overlay
 */

import { MarkdownRenderer, Component } from 'obsidian';

/** 检测文本是否包含 mermaid 代码块 */
export function containsMermaid(text: string): boolean {
  return /```mermaid\s*[\s\S]*?```/.test(text);
}

/**
 * 附加全屏展开按钮到预览/quote 容器
 * @param container - quote 或 preview 容器
 * @param onClick - 点击展开时的回调
 */
export function attachMermaidExpandButton(container: HTMLElement, onClick: () => void): void {
  container.style.position = 'relative';

  const btn = container.createEl('button', {
    cls: 'markvault-mermaid-expand-btn',
    attr: { title: 'Fullscreen preview (Expand mermaid diagram)', 'aria-label': 'Expand mermaid preview' },
  });
  btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="15 3 21 3 21 9"></polyline>
    <polyline points="9 21 3 21 3 15"></polyline>
    <line x1="21" y1="3" x2="14" y2="10"></line>
    <line x1="3" y1="21" x2="10" y2="14"></line>
  </svg>`;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
}

/**
 * 打开 Mermaid 全屏预览浮层
 * @param text - Mermaid 代码块文本
 * @param filePath - 文件路径（供 MarkdownRenderer 使用）
 */
export function openMermaidPreview(text: string, filePath: string): void {
  // ── Zoom/Pan 状态 ──
  const state = {
    zoom: 1.0,
    fitScale: 1.0,
    panX: 0,
    panY: 0,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
  };
  const ZOOM_FACTOR = 1.08;
  const ZOOM_STEP = 0.25;
  const MAX_ZOOM = 5.0;
  const MIN_ZOOM_FACTOR = 0.15;
  const ANIM_DURATION = '0.18s';
  const ANIM_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
  const WHEEL_ANIM_RESTORE_MS = 80;

  let rafId = 0;
  let wheelTransTimer: ReturnType<typeof setTimeout> | null = null;
  const cleanupFns: (() => void)[] = [];

  // ═══════ DOM 结构 ═══════
  const overlay = document.createElement('div');
  overlay.addClass('markvault-mermaid-overlay');

  const modal = overlay.createDiv({ cls: 'markvault-mermaid-modal' });

  // ── 工具栏 ──
  const toolbar = modal.createDiv({ cls: 'markvault-mermaid-toolbar' });
  const leftGroup = toolbar.createDiv({ cls: 'markvault-mermaid-toolbar-left' });
  leftGroup.createSpan({ text: 'Mermaid Diagram Preview', cls: 'markvault-mermaid-title' });

  const zoomGroup = toolbar.createDiv({ cls: 'markvault-mermaid-zoom-group' });

  const zoomOutBtn = zoomGroup.createEl('button', {
    cls: 'markvault-mermaid-zoom-btn',
    attr: { title: 'Zoom out (-)', 'aria-label': 'Zoom out' },
  });
  zoomOutBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;

  const zoomLabel = zoomGroup.createSpan({ text: 'Fit', cls: 'markvault-mermaid-zoom-label' });

  const zoomInBtn = zoomGroup.createEl('button', {
    cls: 'markvault-mermaid-zoom-btn',
    attr: { title: 'Zoom in (+)', 'aria-label': 'Zoom in' },
  });
  zoomInBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;

  const resetBtn = zoomGroup.createEl('button', {
    cls: 'markvault-mermaid-zoom-btn markvault-mermaid-zoom-reset',
    attr: { title: 'Reset to fit (Ctrl+0)', 'aria-label': 'Reset zoom' },
  });
  resetBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><polyline points="23 20 23 14 17 14"></polyline><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path></svg>`;

  const rightGroup = toolbar.createDiv({ cls: 'markvault-mermaid-toolbar-right' });
  const closeBtn = rightGroup.createEl('button', {
    cls: 'markvault-mermaid-close-btn',
    attr: { title: 'Close (Esc)', 'aria-label': 'Close preview' },
  });
  closeBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

  // ── 视口 + 变换层 ──
  const viewport = modal.createDiv({ cls: 'markvault-mermaid-viewport' });
  const canvas = viewport.createDiv({ cls: 'markvault-mermaid-canvas' });

  // ═══════ Markdown 渲染 + fitScale 计算 ═══════
  const previewComponent = new Component();
  MarkdownRenderer.renderMarkdown(
    text, canvas, filePath, previewComponent,
  ).then(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        computeFitScale();
        panzoomSetFit();
      });
    });
  }).catch((err: unknown) => {
    console.error('MarkVault: mermaid preview render failed', err);
    canvas.createEl('pre', { text, cls: 'markvault-mermaid-fallback' });
  });

  function computeFitScale() {
    const svg = canvas.querySelector('svg');
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (!svg || vw <= 0 || vh <= 0) { state.fitScale = 1.0; return; }

    const viewBox = svg.getAttribute('viewBox');
    let svgW: number, svgH: number;
    if (viewBox) {
      const parts = viewBox.split(/[\s,]+/).map(Number);
      svgW = parts[2] || 0;
      svgH = parts[3] || 0;
    } else {
      const rect = svg.getBoundingClientRect();
      svgW = rect.width;
      svgH = rect.height;
    }

    if (svgW <= 0 || svgH <= 0) { state.fitScale = 1.0; return; }

    const padW = 40, padH = 32;
    const scaleW = (vw - padW) / svgW;
    const scaleH = (vh - padH) / svgH;
    state.fitScale = Math.min(1.0, scaleW, scaleH);
  }

  // ═══════ PanZoom 核心 ═══════

  const applyTransform = () => {
    canvas.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  };

  const enableTransition = () => {
    canvas.style.transition = `transform ${ANIM_DURATION} ${ANIM_EASE}`;
  };

  const disableTransition = () => {
    canvas.style.transition = 'none';
  };

  const updateZoomLabel = () => {
    zoomLabel.setText(`${Math.round(state.zoom * 100)}%`);
  };

  const zoomAt = (newZoom: number, cx: number, cy: number) => {
    const minZoom = Math.min(MIN_ZOOM_FACTOR, state.fitScale);
    const clamped = Math.max(minZoom, Math.min(MAX_ZOOM, newZoom));
    if (clamped === state.zoom) return;
    const ptX = (cx - state.panX) / state.zoom;
    const ptY = (cy - state.panY) / state.zoom;
    state.zoom = clamped;
    state.panX = cx - ptX * clamped;
    state.panY = cy - ptY * clamped;
    applyTransform();
    updateZoomLabel();
  };

  const panzoomSetFit = () => {
    enableTransition();
    state.zoom = state.fitScale;
    state.panX = 0;
    state.panY = 0;
    applyTransform();
    updateZoomLabel();
    setTimeout(disableTransition, 180);
  };

  // ═══════ 事件: 鼠标滚轮 ═══════

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.isDragging) return;
    disableTransition();
    if (wheelTransTimer !== null) {
      clearTimeout(wheelTransTimer);
      wheelTransTimer = null;
    }
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      const rect = viewport.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
      zoomAt(state.zoom * factor, cx, cy);
    });
    wheelTransTimer = setTimeout(() => {
      wheelTransTimer = null;
    }, WHEEL_ANIM_RESTORE_MS);
  };

  viewport.addEventListener('wheel', onWheel, { passive: false });
  cleanupFns.push(() => viewport.removeEventListener('wheel', onWheel));

  // ═══════ 事件: 鼠标拖拽 ═══════

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    state.isDragging = true;
    state.dragStartX = e.clientX - state.panX;
    state.dragStartY = e.clientY - state.panY;
    disableTransition();
    viewport.addClass('markvault-mermaid-grabbing');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!state.isDragging) return;
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      state.panX = e.clientX - state.dragStartX;
      state.panY = e.clientY - state.dragStartY;
      applyTransform();
    });
  };

  const onMouseUp = () => {
    if (!state.isDragging) return;
    state.isDragging = false;
    viewport.removeClass('markvault-mermaid-grabbing');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };

  viewport.addEventListener('mousedown', onMouseDown);
  cleanupFns.push(() => viewport.removeEventListener('mousedown', onMouseDown));
  cleanupFns.push(() => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  });

  // ═══════ 事件: 双击 ═══════

  viewport.addEventListener('dblclick', (e: MouseEvent) => {
    e.preventDefault();
    enableTransition();
    if (state.zoom > state.fitScale * 1.05) {
      panzoomSetFit();
    } else {
      const rect = viewport.getBoundingClientRect();
      zoomAt(1.0, e.clientX - rect.left, e.clientY - rect.top);
      setTimeout(disableTransition, 180);
    }
  });

  // ═══════ 事件: 触摸 ═══════

  let lastTouchDist = 0;
  let touchRafId = 0;

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      const [t1, t2] = [e.touches[0], e.touches[1]];
      lastTouchDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      disableTransition();
    } else if (e.touches.length === 1) {
      state.isDragging = true;
      state.dragStartX = e.touches[0].clientX - state.panX;
      state.dragStartY = e.touches[0].clientY - state.panY;
      disableTransition();
    }
  };

  const onTouchMove = (e: TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 2) {
      if (touchRafId) return;
      touchRafId = requestAnimationFrame(() => {
        touchRafId = 0;
        const [t1, t2] = [e.touches[0], e.touches[1]];
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        if (lastTouchDist > 0) {
          const rect = viewport.getBoundingClientRect();
          const cx = (t1.clientX + t2.clientX) / 2 - rect.left;
          const cy = (t1.clientY + t2.clientY) / 2 - rect.top;
          zoomAt(state.zoom * (dist / lastTouchDist), cx, cy);
        }
        lastTouchDist = dist;
      });
    } else if (e.touches.length === 1 && state.isDragging) {
      if (touchRafId) return;
      touchRafId = requestAnimationFrame(() => {
        touchRafId = 0;
        state.panX = e.touches[0].clientX - state.dragStartX;
        state.panY = e.touches[0].clientY - state.dragStartY;
        applyTransform();
      });
    }
  };

  const onTouchEnd = () => {
    state.isDragging = false;
    lastTouchDist = 0;
    if (touchRafId) { cancelAnimationFrame(touchRafId); touchRafId = 0; }
  };

  viewport.addEventListener('touchstart', onTouchStart, { passive: false });
  viewport.addEventListener('touchmove', onTouchMove, { passive: false });
  viewport.addEventListener('touchend', onTouchEnd);
  cleanupFns.push(() => {
    viewport.removeEventListener('touchstart', onTouchStart);
    viewport.removeEventListener('touchmove', onTouchMove);
    viewport.removeEventListener('touchend', onTouchEnd);
  });

  // ═══════ 工具栏按钮 ═══════

  zoomInBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    enableTransition();
    const rect = viewport.getBoundingClientRect();
    zoomAt(state.zoom + ZOOM_STEP, rect.width / 2, rect.height / 2);
    setTimeout(disableTransition, 180);
  });

  zoomOutBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    enableTransition();
    const rect = viewport.getBoundingClientRect();
    zoomAt(state.zoom - ZOOM_STEP, rect.width / 2, rect.height / 2);
    setTimeout(disableTransition, 180);
  });

  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    panzoomSetFit();
  });

  // ═══════ 键盘快捷键 ═══════

  const keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.ctrlKey && e.key === '0') { e.preventDefault(); panzoomSetFit(); return; }
    if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      enableTransition();
      const rect = viewport.getBoundingClientRect();
      zoomAt(state.zoom + ZOOM_STEP, rect.width / 2, rect.height / 2);
      setTimeout(disableTransition, 180);
      return;
    }
    if (e.ctrlKey && e.key === '-') {
      e.preventDefault();
      enableTransition();
      const rect = viewport.getBoundingClientRect();
      zoomAt(state.zoom - ZOOM_STEP, rect.width / 2, rect.height / 2);
      setTimeout(disableTransition, 180);
      return;
    }
  };
  document.addEventListener('keydown', keyHandler);
  cleanupFns.push(() => document.removeEventListener('keydown', keyHandler));

  // ═══════ 关闭 ═══════

  function close() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (touchRafId) { cancelAnimationFrame(touchRafId); touchRafId = 0; }
    if (wheelTransTimer !== null) { clearTimeout(wheelTransTimer); wheelTransTimer = null; }
    for (const fn of cleanupFns) fn();
    cleanupFns.length = 0;
    previewComponent.unload();
    overlay.addClass('markvault-mermaid-overlay-closing');
    setTimeout(() => overlay.remove(), 200);
  }

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // ═══════ 挂载到 DOM ═══════
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.addClass('markvault-mermaid-overlay-visible'));
}
