/**
 * Tree-Org Layout — 自上而下组织架构图布局
 *
 * 布局方向：根节点在顶部，子节点向下展开
 *
 *       root
 *      ┌──┴──┐
 *   child1  child2
 *     │       │
 *  grandchild grandchild2
 *
 * 算法：tree-right 的 X/Y 镜像——
 *   tree-right: children stacked vertically, levels go right
 *   tree-org:   children stacked horizontally, levels go down
 */

import type { MindNode } from '../types/mind-node';
import {
  estimateNodeWidth,
  getNodeHeight,
} from './tree-layout';

/** 层级垂直间距 — P0(重叠修复): 60→90 */
const LEVEL_GAP = 90;

/** 兄弟节点水平间距 — P0(重叠修复): 24→40 */
const SIBLING_GAP = 40;

/** 根节点起始坐标 */
const ROOT_X = 40;
const ROOT_Y = 40;

/** Fix 5: 优先使用 renderedWidth，回退到估算值 */
function getNodeWidth(node: MindNode): number {
  if (node.renderedWidth && node.renderedWidth > 0) {
    return node.renderedWidth;
  }
  return estimateNodeWidth(node);
}

/**
 * 预计算子树宽度（tree-org 方向是横向宽度，不是高度）
 */
export function orgPrecomputeSubtreeWidths(root: MindNode): void {
  function walk(node: MindNode): number {
    let width: number;
    if (node.collapsed || node.children.length === 0) {
      width = getNodeWidth(node);
    } else {
      let total = 0;
      for (let i = 0; i < node.children.length; i++) {
        total += walk(node.children[i]);
        if (i < node.children.length - 1) {
          total += SIBLING_GAP;
        }
      }
      width = Math.max(getNodeWidth(node), total);
    }
    node._subtreeWidth = width;
    return width;
  }
  walk(root);
}

/** 查询缓存的子树宽度 */
function subtreeWidth(node: MindNode): number {
  return node._subtreeWidth ?? getNodeWidth(node);
}

/**
 * 自顶向下分配坐标（tree-org: parent at top, children below）
 */
function orgAssignLayout(node: MindNode, x: number, y: number): void {
  const totalWidth = subtreeWidth(node);
  const nodeHeight = getNodeHeight(node);
  const nodeWidth = node.renderedWidth && node.renderedWidth > 0
    ? node.renderedWidth
    : estimateNodeWidth(node);

  // 父节点水平居中于子节点跨度
  const nodeX = x + (totalWidth - nodeWidth) / 2;

  node.layout = {
    x: nodeX,
    y,
    width: nodeWidth,
    height: nodeHeight,
  };

  // 折叠或叶子 → 不布局子节点
  if (node.collapsed || node.children.length === 0) return;

  // 子节点从下方开始排列
  const childY = y + nodeHeight + LEVEL_GAP;
  let childX = x;

  for (const child of node.children) {
    const childSubtreeWidth = subtreeWidth(child);
    orgAssignLayout(child, childX, childY);
    childX += childSubtreeWidth + SIBLING_GAP;
  }
}

/**
 * Org 布局入口
 */
export function orgLayoutTree(root: MindNode): MindNode {
  orgPrecomputeSubtreeWidths(root);
  orgAssignLayout(root, ROOT_X, ROOT_Y);
  return root;
}

/**
 * Org 重布局
 */
export function orgRelayoutWithMeasured(root: MindNode): MindNode {
  orgPrecomputeSubtreeWidths(root);
  orgAssignLayout(root, ROOT_X, ROOT_Y);
  return root;
}
