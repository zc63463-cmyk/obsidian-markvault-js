/**
 * Freeform Layout — 自由布局
 *
 * 非刚性结构，适合创意发散、头脑风暴场景。
 * 基于径向布局的初始位置，加入随机偏移和碰撞避让，
 * 产生自然、不拘束的视觉效果。
 *
 * 算法：
 *   1. 径向初排 — 叶子数权重分配角度扇区
 *   2. 随机偏移 — 在环内 ±25% 半径抖动
 *   3. 碰撞检测 — 检测相邻节点是否重叠，推开重叠节点
 */

import type { MindNode } from '../types/mind-node';
import { getNodeHeight, estimateNodeWidth } from './tree-layout';

/** 环间距 */
const RING_GAP = 300;

/** 根节点中心 */
const CENTER_X = 500;
const CENTER_Y = 400;

/** 最小节点间距 (px)，用于碰撞检测 */
const MIN_NODE_DISTANCE = 24;

function countLeaves(node: MindNode): number {
  if (node.collapsed || node.children.length === 0) return 1;
  let total = 0;
  for (const child of node.children) {
    total += countLeaves(child);
  }
  return Math.max(total, 1);
}

function precomputeLeaves(root: MindNode): void {
  function walk(node: MindNode): number {
    if (node.collapsed || node.children.length === 0) {
      node._leafCount = 1;
      return 1;
    }
    let total = 0;
    for (const child of node.children) {
      total += walk(child);
    }
    node._leafCount = Math.max(total, 1);
    return node._leafCount;
  }
  walk(root);
}

/** 伪随机数生成器 (seedable) — 基于索引的小扰动 */
function jitter(idx: number, maxPx: number): number {
  const seed = (idx * 2654435761) % 1000000;
  return ((seed % (maxPx * 2)) - maxPx);
}

export function freeformLayoutTree(root: MindNode): MindNode {
  // 局部变量 — 每调独立，避免多视图间状态污染
  const globalPlaced: Array<{ x: number; y: number; w: number; h: number }> = [];
  precomputeLeaves(root);

  const rootWidth = root.renderedWidth && root.renderedWidth > 0
    ? root.renderedWidth
    : estimateNodeWidth(root);
  const rootHeight = getNodeHeight(root);

  root.layout = {
    x: CENTER_X - rootWidth / 2,
    y: CENTER_Y - rootHeight / 2,
    width: rootWidth,
    height: rootHeight,
  };

  if (root.collapsed || root.children.length === 0) return root;

  assignFreeformLayout(root, 0, Math.PI * 2, 1, globalPlaced);

  return root;
}

function assignFreeformLayout(
  node: MindNode,
  startAngle: number,
  endAngle: number,
  level: number,
  globalPlaced: Array<{ x: number; y: number; w: number; h: number }>,
): void {
  if (node.collapsed || node.children.length === 0) return;

  const baseRadius = level * RING_GAP;
  const totalLeaves = node._leafCount ?? 1;
  const angleSpan = endAngle - startAngle;
  const childCount = node.children.length;

  let currentAngle = startAngle;

  // 收集本层所有节点位置，用于碰撞检测
  interface PlacedNode {
    node: MindNode;
    x: number;
    y: number;
    w: number;
    h: number;
    angle: number;
    radius: number;
  }
  const placed: PlacedNode[] = [];

  for (let i = 0; i < childCount; i++) {
    const child = node.children[i];
    const childLeaves = child._leafCount ?? 1;
    const childAngleSpan = (childLeaves / totalLeaves) * angleSpan;
    const childAngle = currentAngle + childAngleSpan / 2;

    // 随机半径偏移 (±20%，让同层节点不在严格圆环上)
    const radiusJitter = jitter(i, Math.floor(baseRadius * 0.2));
    const radius = baseRadius + radiusJitter;

    const childWidth = child.renderedWidth && child.renderedWidth > 0
      ? child.renderedWidth
      : estimateNodeWidth(child);
    const childHeight = getNodeHeight(child);

    // 初始位置（按角度+半径）
    let px = CENTER_X + Math.cos(childAngle) * radius - childWidth / 2;
    let py = CENTER_Y + Math.sin(childAngle) * radius - childHeight / 2;

    // P0 修复: 碰撞检测合并同层 + 全局已放置节点
    const allObstacles = [...placed, ...globalPlaced.map(p => ({ ...p, angle: 0 }))];
    const placedSorted = allObstacles.sort((a, b) =>
      Math.abs(a.angle - childAngle) - Math.abs(b.angle - childAngle),
    );

    for (let attempt = 0; attempt < 5; attempt++) {
      let hasCollision = false;
      for (const other of placedSorted) {
        const dx = (px + childWidth / 2) - (other.x + other.w / 2);
        const dy = (py + childHeight / 2) - (other.y + other.h / 2);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = (childWidth + other.w) / 2 + MIN_NODE_DISTANCE;

        if (dist < minDist) {
          hasCollision = true;
          // 沿远离碰撞方向推开
          const pushAngle = dist > 0.1 ? Math.atan2(dy, dx) : childAngle;
          const pushDist = (minDist - dist + 4) * 0.6;
          px += Math.cos(pushAngle) * pushDist;
          py += Math.sin(pushAngle) * pushDist;
        }
      }
      if (!hasCollision) break;
    }

    child.layout = {
      x: px,
      y: py,
      width: childWidth,
      height: childHeight,
    };

    placed.push({ node: child, x: px, y: py, w: childWidth, h: childHeight, angle: childAngle, radius });
    // P0 修复: 添加到全局列表，供其他层碰撞检测使用
    globalPlaced.push({ x: px, y: py, w: childWidth, h: childHeight });

    // P0 修复: 始终递归子节点，不再因角度过小而跳过
    if (!child.collapsed && child.children.length > 0) {
      const margin = childAngleSpan * 0.15;
      assignFreeformLayout(child, currentAngle + margin, currentAngle + childAngleSpan - margin, level + 1, globalPlaced);
    }

    currentAngle += childAngleSpan;
  }
}

export function freeformRelayoutWithMeasured(root: MindNode): MindNode {
  return freeformLayoutTree(root);
}
