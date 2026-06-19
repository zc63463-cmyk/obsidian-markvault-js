/**
 * MindFlow Outline — 大纲模式
 *
 * Step 2 of P0-1 split from mindflow-view.ts
 *
 * 所有函数接受 context 对象操作视图状态，
 * 避免直接访问 MindFlowView.this。
 */

import type { MindNode } from '../types/mind-node';

/** 大纲模式上下文 — MindFlowView 暴露的状态 */
export interface OutlineContext {
  rootNode: MindNode | null;
  selectedNodeId: string | null;
  viewportEl: HTMLElement | null;
  outlineEl: HTMLElement | null;
  _isOutlineMode: boolean;
  _outlineRefreshTimer: ReturnType<typeof setTimeout> | null;
  selectNode: (id: string | null) => void;
  scrollToNode: (id: string) => void;
  toggleCollapse: (id: string) => void;
}

/** 递归渲染大纲树 */
export function renderOutlineTree(
  ctx: OutlineContext,
  node: MindNode,
  container: HTMLElement,
  depth: number,
): void {
  const row = document.createElement('div');
  row.className = 'mf-outline__item';
  row.style.paddingLeft = `${depth * 16 + 4}px`;
  row.style.paddingTop = '3px';
  row.style.paddingBottom = '3px';
  row.style.cursor = 'pointer';
  row.style.fontSize = '13px';
  row.style.borderRadius = '4px';
  row.style.whiteSpace = 'nowrap';
  row.style.overflow = 'hidden';
  row.style.textOverflow = 'ellipsis';

  if (node.id === ctx.selectedNodeId) {
    row.style.background = 'var(--background-modifier-hover, rgba(0,0,0,0.05))';
  }

  if (node.children.length > 0) {
    const toggle = document.createElement('span');
    toggle.textContent = node.collapsed ? '\u25b8 ' : '\u25be ';
    toggle.style.color = 'var(--text-muted, #999)';
    toggle.style.marginRight = '2px';
    row.appendChild(toggle);
  } else {
    const spacer = document.createElement('span');
    spacer.textContent = '  ';
    row.appendChild(spacer);
  }

  const text = document.createElement('span');
  text.textContent = node.text.length > 40 ? node.text.slice(0, 40) + '...' : node.text;
  if (node.type === 'free') {
    text.style.color = 'var(--interactive-accent, #483699)';
  } else if (node.type === 'annotation') {
    text.style.color = 'var(--text-accent, #7C3AED)';
    text.style.fontStyle = 'italic';
  }
  row.appendChild(text);

  row.addEventListener('click', () => {
    ctx.selectNode(node.id);
    ctx.scrollToNode(node.id);
    ctx.outlineEl?.querySelectorAll('.mf-outline__item').forEach(el => {
      (el as HTMLElement).style.background = '';
    });
    row.style.background = 'var(--background-modifier-hover, rgba(0,0,0,0.05))';
  });

  row.addEventListener('dblclick', () => {
    if (node.children.length > 0) {
      ctx.toggleCollapse(node.id);
      hideOutline(ctx);
      showOutline(ctx);
    }
  });

  container.appendChild(row);

  if (!node.collapsed) {
    for (const child of node.children) {
      renderOutlineTree(ctx, child, container, depth + 1);
    }
  }
}

/** 显示大纲面板 */
export function showOutline(ctx: OutlineContext): void {
  if (!ctx.viewportEl || !ctx.rootNode) return;

  ctx.outlineEl = document.createElement('div');
  ctx.outlineEl.className = 'mf-outline';
  ctx.outlineEl.style.position = 'absolute';
  ctx.outlineEl.style.top = '0';
  ctx.outlineEl.style.right = '0';
  ctx.outlineEl.style.width = '280px';
  ctx.outlineEl.style.height = '100%';
  ctx.outlineEl.style.background = 'var(--background-primary, #fff)';
  ctx.outlineEl.style.borderLeft = '1px solid var(--background-modifier-border, #ddd)';
  ctx.outlineEl.style.zIndex = '100';
  ctx.outlineEl.style.overflow = 'auto';
  ctx.outlineEl.style.padding = '8px';

  renderOutlineTree(ctx, ctx.rootNode, ctx.outlineEl, 0);
  ctx.viewportEl.appendChild(ctx.outlineEl);
}

/** 隐藏大纲面板 */
export function hideOutline(ctx: OutlineContext): void {
  if (ctx.outlineEl) {
    ctx.outlineEl.remove();
    ctx.outlineEl = null;
  }
  if (ctx._outlineRefreshTimer) {
    clearTimeout(ctx._outlineRefreshTimer);
    ctx._outlineRefreshTimer = null;
  }
}

/** L2: 延迟刷新大纲，debounce 100ms */
export function scheduleOutlineRefresh(ctx: OutlineContext): void {
  if (ctx._outlineRefreshTimer) return;
  ctx._outlineRefreshTimer = setTimeout(() => {
    ctx._outlineRefreshTimer = null;
    if (ctx._isOutlineMode) {
      hideOutline(ctx);
      showOutline(ctx);
    }
  }, 100);
}
