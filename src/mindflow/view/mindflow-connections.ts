/**
 * MindFlow Connections — 标注关系连线 + 自主连线 + 标注集成
 *
 * Step 5 of P0-1 split from mindflow-view.ts
 *
 * 包含 11 个函数:
 *   标注关系: renderRelationEdges, handleRelEdgeClick, handleRelEdgeContextMenu
 *   自主连线: addConnection, renderConnectionEdges, removeConnection, editConnection
 *   标注集成: openAnnotationPicker, jumpToAnnotation, showAnnotationDetail
 *   边标签: openEdgeLabelEditor
 */

import { App, Notice, TFile } from 'obsidian';
import type { MindNode, ConnectionRecord } from '../types/mind-node';
import { createMindNode } from '../types/mind-node';
import { findNode } from '../data/seed-sync';
import { generateId } from '../../utils/id';
import { logger } from '../../utils/logger';
import { ConfirmModal, PromptModal } from '../../ui/confirm-modal';
import {
  renderRelationEdges as renderRelationEdgesSvg,
  findNodePosition,
  getNodeRect,
  rectBoundaryIntersection,
  ensureArrowMarkers,
  type RelationEdge,
} from '../render/svg-connector';
import type { MindflowEvent } from '../core/event-bus';
import {
  AnnotationPickerModal,
  AnnotationDetailModal,
  ConnectionEditModal,
  RelationDetailModal,
  type AnnotationSummary,
  type AnnotationDetail,
  type RelationEdgeInfo,
} from './mindflow-modals';

/** 从 Obsidian App 获取 annotationStore 的类型安全访问器 */
export function getAnnotationStore(app: App): AnnotationStoreAccessor | null {
  const plugin = (app as unknown as { plugins?: { plugins?: Record<string, { annotationStore?: AnnotationStoreAccessor }> } })
    .plugins?.plugins?.['markvault-js'];
  return plugin?.annotationStore ?? null;
}

/** annotationStore 的最小接口 — 仅包含 mindflow-connections.ts 使用的方法 */
export interface AnnotationStoreAccessor {
  getRelations?(uuid: string, options?: { includeInvalidated?: boolean }): {
    outgoing: Array<{ targetUuid: string; type: string; note?: string; invalidAt?: number }>;
    incoming: Array<{ sourceUuid: string; relation: { type: string; note?: string; invalidAt?: number } }>;
  } | null;
  getAnnotationByUuid?(uuid: string): any;
  getAllAnnotations?(): AnnotationSummary[];
  invalidateRelation?(sourceUuid: string, targetUuid: string, type: string): Promise<void>;
  restoreRelation?(sourceUuid: string, targetUuid: string, type: string): Promise<void>;
}

/** 连线上下文 — MindFlowView 暴露的状态和操作 */
export interface ConnectionsContext {
  // DOM
  rootNode: MindNode | null;
  nodeElements: Map<string, HTMLElement>;
  _relSvgEl: SVGSVGElement | null;

  // 数据
  _connections: ConnectionRecord[];
  meta: { connections?: ConnectionRecord[] };
  selectedNodeId: string | null;

  // App
  app: App;

  // View 操作委托
  debouncedSave: () => void;
  layoutAndRender: () => Promise<void>;
  selectNode: (id: string | null) => void;
  renderCacheClear: () => void;
  undoRedoSnapshot: (label: string) => void;
  eventBusEmit: <T extends MindflowEvent['channel']>(
    channel: T,
    payload: Extract<MindflowEvent, { channel: T }>['payload'],
  ) => void;
  getBoundaryCandidateIds: () => string[];
  clearMultiSelect: () => void;
  applySelectionVisual: () => void;

  // 内部渲染互调
  renderRelationEdges: () => void;
  renderConnectionEdges: () => void;
}

// ═══════════════════════════════════════════════════════
// 标注关系连线
// ═══════════════════════════════════════════════════════

export function renderRelationEdgesFn(ctx: ConnectionsContext): void {
  if (!ctx._relSvgEl) return;

  ctx._relSvgEl.querySelectorAll('.mf-rel-edge').forEach(el => el.remove());

  if (!ctx.rootNode) return;

  const store = getAnnotationStore(ctx.app);
  if (!store?.getRelations) return;

  const annToNode = new Map<string, string>();
  const collectAnnNodes = (node: MindNode): void => {
    if (node.type === 'annotation' && node.annotationRef) {
      annToNode.set(node.annotationRef, node.id);
    }
    for (const child of node.children) collectAnnNodes(child);
  };
  collectAnnNodes(ctx.rootNode);

  if (annToNode.size < 2) return;

  const relEdges: RelationEdge[] = [];
  const seen = new Set<string>();

  const annUuids = Array.from(annToNode.keys());
  for (const uuidA of annUuids) {
    const relations = store.getRelations(uuidA, { includeInvalidated: true });
    if (!relations) continue;

    for (const rel of relations.outgoing) {
      if (annToNode.has(rel.targetUuid)) {
        const key = [uuidA, rel.targetUuid].sort().join(':');
        if (seen.has(key)) continue;
        seen.add(key);

        relEdges.push({
          fromNodeId: annToNode.get(uuidA)!,
          toNodeId: annToNode.get(rel.targetUuid)!,
          sourceUuid: uuidA,
          targetUuid: rel.targetUuid,
          relationType: rel.type,
          relationNote: rel.note,
          invalidated: !!rel.invalidAt,
        });
      }
    }

    for (const rel of relations.incoming) {
      if (annToNode.has(rel.sourceUuid)) {
        const key = [uuidA, rel.sourceUuid].sort().join(':');
        if (seen.has(key)) continue;
        seen.add(key);

        relEdges.push({
          fromNodeId: annToNode.get(uuidA)!,
          toNodeId: annToNode.get(rel.sourceUuid)!,
          sourceUuid: uuidA,
          targetUuid: rel.sourceUuid,
          relationType: rel.relation.type,
          relationNote: rel.relation.note,
          invalidated: !!rel.relation.invalidAt,
        });
      }
    }
  }

  renderRelationEdgesSvg(
    relEdges,
    ctx._relSvgEl,
    ctx.nodeElements,
    ctx.rootNode,
    (edge, event) => { handleRelEdgeContextMenu(ctx, edge, event); },
    (edge, event) => { handleRelEdgeClick(ctx, edge, event); },
  );
}

export function handleRelEdgeClick(ctx: ConnectionsContext, edge: RelationEdge, _event: MouseEvent): void {
  const store = getAnnotationStore(ctx.app);
  if (!store) {
    new Notice('Annotation store not available');
    return;
  }

  const sourceAnn = store.getAnnotationByUuid?.(edge.sourceUuid);
  const targetAnn = store.getAnnotationByUuid?.(edge.targetUuid);

  const sourceText = sourceAnn?.bodyText || sourceAnn?.quote || sourceAnn?.text || '(unknown)';
  const targetText = targetAnn?.bodyText || targetAnn?.quote || targetAnn?.text || '(unknown)';

  const edgeInfo: RelationEdgeInfo = {
    sourceUuid: edge.sourceUuid,
    targetUuid: edge.targetUuid,
    relationType: edge.relationType,
    relationNote: edge.relationNote,
    invalidated: edge.invalidated,
  };

  const modal = new RelationDetailModal(
    ctx.app,
    edgeInfo,
    sourceText,
    targetText,
    () => { handleRelEdgeContextMenu(ctx, edge, _event); },
    () => { handleRelEdgeContextMenu(ctx, edge, _event); },
  );
  modal.open();
}

export async function handleRelEdgeContextMenu(ctx: ConnectionsContext, edge: RelationEdge, _event: MouseEvent): Promise<void> {
  const store = getAnnotationStore(ctx.app);
  if (!store?.invalidateRelation || !store?.restoreRelation) {
    new Notice('Annotation store not available');
    return;
  }

  const { sourceUuid, targetUuid, relationType } = edge;

  if (edge.invalidated) {
    const confirmed = await ConfirmModal.open(ctx.app, {
      title: 'Restore Annotation Relation',
      message: `Restore relation "${relationType}"?\n\nThis relation was previously soft-deleted and will become active again.`,
      okText: 'Restore',
      cancelText: 'Cancel',
    });
    if (!confirmed) return;

    try {
      await store.restoreRelation(sourceUuid, targetUuid, relationType);
      new Notice(`Relation "${relationType}" restored`);
      ctx.renderRelationEdges();
    } catch (err) {
      logger.error('Failed to restore relation', err);
      new Notice('Failed to restore relation');
    }
  } else {
    const noteText = edge.relationNote
      ? `\nNote: ${edge.relationNote.length > 40 ? edge.relationNote.slice(0, 40) + '\u2026' : edge.relationNote}`
      : '';

    const confirmed = await ConfirmModal.open(ctx.app, {
      title: 'Remove Annotation Relation',
      message: `Soft-delete relation "${relationType}"?\n\nFrom: ${sourceUuid.slice(0, 8)}\u2026\nTo: ${targetUuid.slice(0, 8)}\u2026${noteText}\n\nThe line will dim and can be restored by right-clicking it.`,
      okText: 'Remove',
      cancelText: 'Cancel',
      dangerous: true,
    });
    if (!confirmed) return;

    try {
      await store.invalidateRelation(sourceUuid, targetUuid, relationType);
      new Notice(`Relation "${relationType}" dimmed (right-click to restore)`);
      ctx.renderRelationEdges();
    } catch (err) {
      logger.error('Failed to invalidate relation', err);
      new Notice('Failed to remove relation');
    }
  }
}

// ═══════════════════════════════════════════════════════
// 自主连线
// ═══════════════════════════════════════════════════════

export function addConnection(ctx: ConnectionsContext): void {
  const ids = ctx.getBoundaryCandidateIds();
  if (ids.length < 2) {
    new Notice('Select at least 2 nodes (Shift+click for multi-select)');
    return;
  }

  let added = 0;
  for (let i = 0; i < ids.length - 1; i++) {
    const connId = `conn-${Date.now()}-${i}`;
    ctx._connections.push({ id: connId, sourceId: ids[i], targetId: ids[i + 1], label: '' });
    added++;
  }

  ctx.meta.connections = ctx._connections;
  ctx.renderConnectionEdges();
  ctx.debouncedSave();
  ctx.clearMultiSelect();
  ctx.applySelectionVisual();
  new Notice(`Added ${added} connection(s)`);
}

export function renderConnectionEdgesFn(ctx: ConnectionsContext): void {
  if (!ctx._relSvgEl) return;

  ctx._relSvgEl.querySelectorAll('.mf-conn-edge').forEach(el => el.remove());

  if (ctx._connections.length === 0) return;

  const arrowMarkerId = ensureArrowMarkers(ctx._relSvgEl);

  for (const conn of ctx._connections) {
    const fromCenter = findNodePosition(conn.sourceId, ctx.nodeElements, ctx.rootNode);
    const toCenter = findNodePosition(conn.targetId, ctx.nodeElements, ctx.rootNode);
    const fromRect = getNodeRect(conn.sourceId, ctx.nodeElements, ctx.rootNode);
    const toRect = getNodeRect(conn.targetId, ctx.nodeElements, ctx.rootNode);

    if (!fromCenter || !toCenter) continue;

    const p1 = fromRect ? rectBoundaryIntersection(fromRect, toCenter.x, toCenter.y) : fromCenter;
    const p2 = toRect ? rectBoundaryIntersection(toRect, fromCenter.x, fromCenter.y) : toCenter;

    const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
    const dx = Math.abs(x2 - x1) * 0.3;
    const dy = Math.abs(y2 - y1) * 0.3;
    const d = `M ${x1} ${y1} C ${x1 + dx} ${y1 + dy / 2}, ${x2 - dx} ${y2 - dy / 2}, ${x2} ${y2}`;

    const color = '#8B5CF6';

    // hitArea
    const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hitArea.setAttribute('d', d);
    hitArea.setAttribute('fill', 'none');
    hitArea.setAttribute('stroke', 'transparent');
    hitArea.setAttribute('stroke-width', '14');
    hitArea.setAttribute('stroke-linecap', 'round');
    hitArea.style.pointerEvents = 'stroke';
    hitArea.style.cursor = 'pointer';
    hitArea.style.transition = 'opacity 0.15s';
    hitArea.classList.add('mf-conn-edge');
    hitArea.setAttribute('title', (conn.label || 'Connection') + (conn.note ? `: ${conn.note}` : '') + '\n\u21b5 \u5de6\u952e\u7f16\u8f91  |  \u27f3 \u53f3\u952e\u5220\u9664');

    hitArea.addEventListener('click', (e) => {
      e.stopPropagation();
      editConnection(ctx, conn.id);
    });

    hitArea.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeConnection(ctx, conn.id);
    });

    hitArea.addEventListener('mouseenter', () => {
      (hitArea.nextSibling as SVGPathElement)?.setAttribute('opacity', '1.0');
    });
    hitArea.addEventListener('mouseleave', () => {
      (hitArea.nextSibling as SVGPathElement)?.setAttribute('opacity', '0.65');
    });

    ctx._relSvgEl.appendChild(hitArea);

    // visible path
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2.5');
    path.setAttribute('stroke-dasharray', '10 4');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('opacity', '0.65');
    path.setAttribute('marker-end', `url(#${arrowMarkerId})`);
    path.classList.add('mf-conn-edge');
    path.style.pointerEvents = 'none';
    path.style.transition = 'opacity 0.15s';

    if (conn.label) {
      const labelX = (x1 + x2) / 2;
      const labelY = (y1 + y2) / 2 - 8;
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', String(labelX));
      text.setAttribute('y', String(labelY));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', color);
      text.setAttribute('font-size', '10');
      text.setAttribute('font-family', 'system-ui, sans-serif');
      text.textContent = conn.label;
      text.classList.add('mf-conn-edge');
      ctx._relSvgEl.appendChild(text);
    }

    ctx._relSvgEl.appendChild(path);
  }
}

export async function removeConnection(ctx: ConnectionsContext, connId: string): Promise<void> {
  const conn = ctx._connections.find(c => c.id === connId);
  if (!conn) return;

  const hasLabel = conn.label && conn.label.trim().length > 0;
  const noteText = conn.note?.trim();
  const hasNote = Boolean(noteText);
  const details: string[] = [];
  if (hasLabel) details.push(`Label: ${conn.label}`);
  if (hasNote && noteText) details.push(`Note: ${noteText.length > 40 ? noteText.slice(0, 40) + '\u2026' : noteText}`);

  const message = details.length > 0
    ? `Delete connection?\n\n${details.join('\n')}\n\nThis will permanently remove the connection line and its data.`
    : 'Delete this connection line?';

  const confirmed = await ConfirmModal.open(ctx.app, {
    title: 'Remove Connection',
    message,
    okText: 'Delete',
    cancelText: 'Cancel',
    dangerous: true,
  });
  if (!confirmed) return;

  const before = ctx._connections.length;
  ctx._connections = ctx._connections.filter(c => c.id !== connId);
  if (ctx._connections.length !== before) {
    ctx.meta.connections = ctx._connections.length > 0 ? ctx._connections : undefined;
    ctx.renderConnectionEdges();
    ctx.debouncedSave();
    new Notice('Connection removed');
  }
}

export function editConnection(ctx: ConnectionsContext, connId: string): void {
  const conn = ctx._connections.find(c => c.id === connId);
  if (!conn) return;

  const modal = new ConnectionEditModal(ctx.app, conn.label, conn.note ?? '', (label, note) => {
    conn.label = label;
    conn.note = note || undefined;
    ctx.meta.connections = ctx._connections;
    ctx.renderConnectionEdges();
    ctx.debouncedSave();
  });
  modal.open();
}

// ═══════════════════════════════════════════════════════
// 标注集成
// ═══════════════════════════════════════════════════════

export function openAnnotationPicker(ctx: ConnectionsContext): void {
  if (!ctx.selectedNodeId || !ctx.rootNode) {
    new Notice('Select a parent node first');
    return;
  }

  const parentId = ctx.selectedNodeId;
  const parent = findNode(ctx.rootNode, parentId);
  if (!parent) return;

  // v6.1: 使用 SearchEngine 替代直接 getAllAnnotations
  const engine = (ctx.app as unknown as {
    plugins?: { plugins?: Record<string, { getSearchEngine?: () => any }> };
  }).plugins?.plugins?.['markvault-js']?.getSearchEngine?.();
  if (!engine) {
    new Notice('Annotation search not available');
    return;
  }

  const store = getAnnotationStore(ctx.app);
  if (!store) {
    new Notice('Annotation store not available');
    return;
  }

  const allAnnotations: AnnotationSummary[] = store.getAllAnnotations?.() ?? [];
  if (allAnnotations.length === 0) {
    new Notice('No annotations found. Create annotations first.');
    return;
  }

  const modal = new AnnotationPickerModal(
    ctx.app,
    engine,
    async (annotationUuid: string, summary: string) => {
      ctx.undoRedoSnapshot('insertAnnotation');

      const newNode = createMindNode({
        id: `ann-${generateId()}`,
        type: 'annotation',
        parentId: parent.id,
        text: summary,
        annotationRef: annotationUuid,
        annotationSummary: summary,
        children: [],
      });
      parent.children.push(newNode);

      ctx.eventBusEmit('operation', { name: 'insertAnnotation', nodeId: newNode.id });
      ctx.renderCacheClear();
      await ctx.layoutAndRender();
      ctx.selectNode(newNode.id);
    },
  );
  modal.open();
}

export function jumpToAnnotation(ctx: ConnectionsContext, annotationUuid: string): void {
  const store = getAnnotationStore(ctx.app);
  if (!store) {
    new Notice('Annotation store not available');
    return;
  }

  const annotation = store.getAnnotationByUuid?.(annotationUuid);
  if (!annotation) {
    new Notice('Annotation not found (may have been deleted)');
    return;
  }

  if (annotation.filePath) {
    const file = ctx.app.vault.getAbstractFileByPath(annotation.filePath);
    if (file instanceof TFile) {
      ctx.app.workspace.openLinkText(annotation.filePath, '', false);
    }
  }
}

export function showAnnotationDetail(ctx: ConnectionsContext, annotationUuid: string): void {
  const store = getAnnotationStore(ctx.app);
  if (!store) {
    new Notice('Annotation store not available');
    return;
  }

  const annotation: AnnotationDetail = store.getAnnotationByUuid?.(annotationUuid);
  if (!annotation) {
    new Notice('Annotation not found (may have been deleted)');
    return;
  }

  const modal = new AnnotationDetailModal(ctx.app, annotation, (uuid) => {
    jumpToAnnotation(ctx, uuid);
  });
  modal.open();
}

// ═══════════════════════════════════════════════════════
// 边标签编辑
// ═══════════════════════════════════════════════════════

export async function openEdgeLabelEditor(ctx: ConnectionsContext, nodeId: string): Promise<void> {
  if (!ctx.rootNode) return;
  const node = findNode(ctx.rootNode, nodeId);
  if (!node) return;

  const label = await PromptModal.open(ctx.app, {
    title: 'Edge Label',
    message: `Label for connection to parent node:\n"${node.text.slice(0, 30)}"`,
    defaultValue: node.edgeLabel ?? '',
    placeholder: 'e.g. "counterexample", "step 1"',
    okText: 'Next',
    cancelText: 'Cancel',
  });
  if (label === null) return;

  const note = await PromptModal.open(ctx.app, {
    title: 'Edge Note (optional)',
    message: `Detail note for edge:\n"${node.text.slice(0, 30)}"`,
    defaultValue: node.edgeNote ?? '',
    placeholder: 'Optional relationship detail...',
    okText: 'Save',
    cancelText: 'Skip',
  });
  if (note === null) return;

  node.edgeLabel = label.trim() || undefined;
  node.edgeNote = note.trim() || undefined;

  ctx.renderCacheClear();
  await ctx.layoutAndRender();
  ctx.selectNode(nodeId);
  ctx.debouncedSave();
  new Notice('Edge label saved');
}
