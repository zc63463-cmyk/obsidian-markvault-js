/**
 * MindFlow Boundary — 外框管理
 *
 * Step 4 of P0-1 split from mindflow-view.ts
 */

import { Notice, App } from 'obsidian';
import type { MindNode, BoundaryRecord } from '../types/mind-node';
import { findParent } from '../data/seed-sync';
import { findNode } from '../data/seed-sync';
import { PromptModal } from '../../ui/confirm-modal';

/** 外框图上下文 */
export interface BoundaryContext {
  rootNode: MindNode | null;
  nodeLayerEl: HTMLElement | null;
  _boundaries: BoundaryRecord[];
  meta: { boundaries?: BoundaryRecord[] };
  getBoundaryCandidateIds: () => string[];
  clearMultiSelect: () => void;
  applySelectionVisual: () => void;
  debouncedSave: () => void;
  renderBoundaries: () => void;
  removeBoundary: (id: string) => void;
  editBoundaryLabel: (id: string) => Promise<void>;
  app: App;
}

export function addBoundary(ctx: BoundaryContext): void {
  if (!ctx.rootNode) {
    new Notice('No mindmap loaded');
    return;
  }

  const candidateIds = ctx.getBoundaryCandidateIds();

  if (candidateIds.length === 0) {
    new Notice('Select node(s) first (Shift+click for multi-select)');
    return;
  }

  if (candidateIds.length === 1) {
    const parent = findParent(ctx.rootNode, candidateIds[0]);
    if (!parent) {
      new Notice('Cannot add boundary to root');
      return;
    }
    const siblingIds = parent.children.map(c => c.id);
    if (siblingIds.length < 2) {
      new Notice('Need at least 2 siblings for a boundary');
      return;
    }

    const boundaryId = `boundary-${Date.now()}`;
    ctx._boundaries.push({ id: boundaryId, nodeIds: siblingIds, label: parent.text.slice(0, 20) });
    ctx.meta.boundaries = ctx._boundaries;
    ctx.renderBoundaries();
    ctx.debouncedSave();
    new Notice(`Boundary added: ${siblingIds.length} siblings`);
  } else {
    const boundaryId = `boundary-${Date.now()}`;
    ctx._boundaries.push({ id: boundaryId, nodeIds: candidateIds, label: `${candidateIds.length} nodes` });
    ctx.meta.boundaries = ctx._boundaries;
    ctx.renderBoundaries();
    ctx.debouncedSave();
    ctx.clearMultiSelect();
    ctx.applySelectionVisual();
    new Notice(`Boundary added: ${candidateIds.length} selected nodes`);
  }
}

export function removeBoundary(ctx: BoundaryContext, boundaryId: string): void {
  const before = ctx._boundaries.length;
  ctx._boundaries = ctx._boundaries.filter(b => b.id !== boundaryId);
  if (ctx._boundaries.length !== before) {
    ctx.meta.boundaries = ctx._boundaries;
    ctx.renderBoundaries();
    ctx.debouncedSave();
    new Notice('Boundary removed');
  }
}

export function cleanupStaleBoundaries(ctx: BoundaryContext): void {
  if (!ctx.rootNode || ctx._boundaries.length === 0) return;

  const allNodeIds = new Set<string>();
  const collectIds = (node: MindNode): void => {
    allNodeIds.add(node.id);
    for (const child of node.children) collectIds(child);
  };
  collectIds(ctx.rootNode);

  const before = ctx._boundaries.length;
  ctx._boundaries = ctx._boundaries.filter(b => b.nodeIds.some(id => allNodeIds.has(id)));
  if (ctx._boundaries.length !== before) {
    ctx.meta.boundaries = ctx._boundaries;
    ctx.renderBoundaries();
    ctx.debouncedSave();
  }
}

export async function editBoundaryLabel(app: App, ctx: BoundaryContext, boundaryId: string): Promise<void> {
  const boundary = ctx._boundaries.find(b => b.id === boundaryId);
  if (!boundary) return;

  const label = await PromptModal.open(app, {
    title: 'Edit Boundary Label',
    message: 'Custom label for the boundary frame:',
    defaultValue: boundary.label,
    placeholder: 'e.g. "Task Flow" or leave empty for "N nodes"',
    okText: 'Next',
    cancelText: 'Cancel',
  });
  if (label === null) return;

  const note = await PromptModal.open(app, {
    title: 'Edit Boundary Note (optional)',
    message: 'Detail note shown as tooltip on hover:',
    defaultValue: boundary.note ?? '',
    placeholder: 'Optional description...',
    okText: 'Save',
    cancelText: 'Skip',
  });
  if (note === null) return;

  boundary.label = label.trim();
  boundary.note = note.trim() || undefined;
  ctx.meta.boundaries = ctx._boundaries;
  ctx.renderBoundaries();
  ctx.debouncedSave();
  new Notice('Boundary label saved');
}

/** 渲染所有外框到 DOM */
export function renderBoundaries(ctx: BoundaryContext): void {
  if (!ctx.nodeLayerEl) return;

  ctx.nodeLayerEl.querySelectorAll('.mf-boundary').forEach(el => el.remove());

  for (const boundary of ctx._boundaries) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasValid = false;

    const collectSubtreeBounds = (nodeId: string): void => {
      const node = ctx.rootNode ? findNode(ctx.rootNode, nodeId) : null;
      if (!node || !node.layout) return;

      minX = Math.min(minX, node.layout.x);
      minY = Math.min(minY, node.layout.y);
      maxX = Math.max(maxX, node.layout.x + node.layout.width);
      maxY = Math.max(maxY, node.layout.y + node.layout.height);
      hasValid = true;

      if (!node.collapsed) {
        for (const child of node.children) {
          collectSubtreeBounds(child.id);
        }
      }
    };

    for (const nodeId of boundary.nodeIds) {
      collectSubtreeBounds(nodeId);
    }

    if (!hasValid) continue;

    const padding = 12;
    const el = document.createElement('div');
    el.className = 'mf-boundary';
    el.dataset.boundaryId = boundary.id;
    el.style.position = 'absolute';
    el.style.left = `${minX - padding}px`;
    el.style.top = `${minY - padding}px`;
    el.style.width = `${maxX - minX + padding * 2}px`;
    el.style.height = `${maxY - minY + padding * 2}px`;
    el.style.border = '2px dashed var(--interactive-accent, #483699)';
    el.style.borderRadius = '12px';
    el.style.background = 'rgba(72, 54, 153, 0.03)';
    el.style.pointerEvents = 'auto';
    el.style.cursor = 'pointer';
    el.style.zIndex = '0';

    const labelText = boundary.label
      ? `${boundary.label} (${boundary.nodeIds.length})`
      : `${boundary.nodeIds.length} nodes`;
    const label = document.createElement('span');
    label.textContent = labelText;
    label.style.position = 'absolute';
    label.style.top = '-10px';
    label.style.left = '12px';
    label.style.fontSize = '11px';
    label.style.fontWeight = '500';
    label.style.color = 'var(--interactive-accent, #483699)';
    label.style.background = 'var(--background-primary, #fff)';
    label.style.padding = '0 4px';
    el.appendChild(label);

    if (boundary.note) {
      label.title = boundary.note;
      label.style.textDecoration = 'underline dotted';
      label.style.cursor = 'help';
    }

    label.addEventListener('click', (e) => {
      e.stopPropagation();
      ctx.editBoundaryLabel(boundary.id);
    });

    const delBtn = document.createElement('span');
    delBtn.textContent = '\u00d7';
    delBtn.style.position = 'absolute';
    delBtn.style.top = '-10px';
    delBtn.style.right = '8px';
    delBtn.style.fontSize = '16px';
    delBtn.style.fontWeight = '500';
    delBtn.style.lineHeight = '1';
    delBtn.style.color = 'var(--text-muted, #888)';
    delBtn.style.background = 'var(--background-primary, #fff)';
    delBtn.style.padding = '0 4px';
    delBtn.style.cursor = 'pointer';
    delBtn.style.borderRadius = '50%';
    delBtn.style.userSelect = 'none';
    delBtn.title = 'Delete this boundary';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      ctx.removeBoundary(boundary.id);
    });
    el.appendChild(delBtn);

    el.addEventListener('mouseenter', () => {
      el.style.background = 'rgba(72, 54, 153, 0.06)';
      delBtn.style.color = 'var(--text-error, #e24b4a)';
    });
    el.addEventListener('mouseleave', () => {
      el.style.background = 'rgba(72, 54, 153, 0.03)';
      delBtn.style.color = 'var(--text-muted, #888)';
    });

    ctx.nodeLayerEl.appendChild(el);
  }
}
