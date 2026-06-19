/**
 * MindFlow Minimap — 小地图
 *
 * Step 3 of P0-1 split from mindflow-view.ts
 */

import type { MindNode } from '../types/mind-node';
import { getLayoutBounds, getVisibleNodes } from '../layout/tree-layout';

/** 小地图上下文 */
export interface MinimapContext {
  rootNode: MindNode | null;
  viewportEl: HTMLElement | null;
  selectedNodeId: string | null;
  viewState: { panX: number; panY: number; scale: number };
  minimapEl: HTMLElement | null;
  minimapCanvas: HTMLCanvasElement | null;
  _minimapAbort: AbortController | null;
  _minimapRafPending: boolean;
  applyTransform: () => void;
  updateMinimap: () => void;
}

export function toggleMinimap(ctx: MinimapContext): void {
  if (ctx.minimapEl) {
    hideMinimap(ctx);
  } else {
    showMinimap(ctx);
  }
}

export function showMinimap(ctx: MinimapContext): void {
  if (!ctx.viewportEl) return;

  ctx.minimapEl = document.createElement('div');
  ctx.minimapEl.className = 'mf-minimap';
  ctx.minimapEl.style.position = 'absolute';
  ctx.minimapEl.style.bottom = '10px';
  ctx.minimapEl.style.right = '10px';
  ctx.minimapEl.style.width = '160px';
  ctx.minimapEl.style.height = '120px';
  ctx.minimapEl.style.background = 'var(--background-secondary, #f5f5f5)';
  ctx.minimapEl.style.border = '1px solid var(--background-modifier-border, #ddd)';
  ctx.minimapEl.style.borderRadius = '8px';
  ctx.minimapEl.style.zIndex = '100';
  ctx.minimapEl.style.overflow = 'hidden';
  ctx.minimapEl.style.cursor = 'pointer';

  ctx.minimapCanvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  ctx.minimapCanvas.width = 160 * dpr;
  ctx.minimapCanvas.height = 120 * dpr;
  ctx.minimapCanvas.style.width = '100%';
  ctx.minimapCanvas.style.height = '100%';
  const canvasCtx = ctx.minimapCanvas.getContext('2d');
  if (canvasCtx) canvasCtx.scale(dpr, dpr);
  ctx.minimapEl.appendChild(ctx.minimapCanvas);

  ctx.minimapEl.addEventListener('click', (e) => {
    if (!ctx.minimapEl) return;
    const rect = ctx.minimapEl.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;
    minimapNavigate(ctx, mx, my);
  });

  ctx.viewportEl.appendChild(ctx.minimapEl);

  ctx._minimapAbort = new AbortController();
  const sig = ctx._minimapAbort.signal;
  ctx.viewportEl.addEventListener('mousemove', () => scheduleMinimapUpdate(ctx), { signal: sig });
  ctx.viewportEl.addEventListener('wheel', () => scheduleMinimapUpdate(ctx), { signal: sig });

  updateMinimap(ctx);
}

export function hideMinimap(ctx: MinimapContext): void {
  if (ctx._minimapAbort) {
    ctx._minimapAbort.abort();
    ctx._minimapAbort = null;
  }
  if (ctx.minimapEl) {
    ctx.minimapEl.remove();
    ctx.minimapEl = null;
  }
  ctx.minimapCanvas = null;
}

export function scheduleMinimapUpdate(ctx: MinimapContext): void {
  if (ctx._minimapRafPending) return;
  ctx._minimapRafPending = true;
  requestAnimationFrame(() => {
    ctx._minimapRafPending = false;
    updateMinimap(ctx);
  });
}

export function updateMinimap(ctx: MinimapContext): void {
  if (!ctx.minimapCanvas || !ctx.rootNode) return;
  const canvasCtx = ctx.minimapCanvas.getContext('2d');
  if (!canvasCtx) return;

  const W = 160, H = 120;
  canvasCtx.clearRect(0, 0, W, H);

  const bounds = getLayoutBounds(ctx.rootNode);
  if (bounds.width === 0 || bounds.height === 0) return;

  const pad = 10;
  const sx = (W - pad * 2) / bounds.width;
  const sy = (H - pad * 2) / bounds.height;
  const scale = Math.min(sx, sy);
  const offsetX = pad - bounds.minX * scale;
  const offsetY = pad - bounds.minY * scale;

  const visibleNodes = getVisibleNodes(ctx.rootNode);
  for (const node of visibleNodes) {
    if (!node.layout) continue;
    const x = node.layout.x * scale + offsetX;
    const y = node.layout.y * scale + offsetY;
    const w = Math.max(node.layout.width * scale, 2);
    const h = Math.max(node.layout.height * scale, 2);

    canvasCtx.fillStyle = node.type === 'free' ? 'rgba(72, 54, 153, 0.5)' : 'rgba(120, 120, 120, 0.4)';
    canvasCtx.fillRect(x, y, w, h);

    if (node.id === ctx.selectedNodeId) {
      canvasCtx.strokeStyle = '#483699';
      canvasCtx.lineWidth = 1.5;
      canvasCtx.strokeRect(x - 1, y - 1, w + 2, h + 2);
    }
  }

  if (ctx.viewportEl) {
    const rect = ctx.viewportEl.getBoundingClientRect();
    const vw = rect.width / ctx.viewState.scale;
    const vh = rect.height / ctx.viewState.scale;
    const vx = (-ctx.viewState.panX / ctx.viewState.scale) * scale + offsetX;
    const vy = (-ctx.viewState.panY / ctx.viewState.scale) * scale + offsetY;
    const vwScaled = vw * scale;
    const vhScaled = vh * scale;

    canvasCtx.strokeStyle = 'rgba(72, 54, 153, 0.6)';
    canvasCtx.lineWidth = 1;
    canvasCtx.setLineDash([3, 2]);
    canvasCtx.strokeRect(vx, vy, vwScaled, vhScaled);
    canvasCtx.setLineDash([]);
  }
}

export function minimapNavigate(ctx: MinimapContext, mx: number, my: number): void {
  if (!ctx.rootNode || !ctx.viewportEl) return;
  const bounds = getLayoutBounds(ctx.rootNode);
  if (bounds.width === 0) return;

  const W = 160, H = 120, pad = 10;
  const sx = (W - pad * 2) / bounds.width;
  const sy = (H - pad * 2) / bounds.height;
  const scale = Math.min(sx, sy);

  const worldX = (mx * W - pad + bounds.minX * scale) / scale;
  const worldY = (my * H - pad + bounds.minY * scale) / scale;

  const rect = ctx.viewportEl.getBoundingClientRect();
  ctx.viewState.panX = rect.width / 2 - worldX * ctx.viewState.scale;
  ctx.viewState.panY = rect.height / 2 - worldY * ctx.viewState.scale;
  ctx.applyTransform();
  updateMinimap(ctx);
}
