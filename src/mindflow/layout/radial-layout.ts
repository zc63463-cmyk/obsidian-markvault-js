/**
 * Radial Layout — 径向布局
 *
 * 根节点在中心，子节点环绕辐射展开，每层一个环。
 * 适合概念图/脑图风格，视觉上均匀分布。
 *
 *        child1
 *          |
 *   child2 ─ root ─ child3
 *          |
 *        child4
 *
 * 算法：
 *   1. 自底向上计算每个节点的叶子数量（权重）
 *   2. 自顶向下按角度扇区分配位置
 *   3. 每层环半径 = level * RING_GAP
 *   4. 子节点在父节点扇区内按叶子数比例分配角度
 */

import type { MindNode } from '../types/mind-node';
import { getNodeHeight, estimateNodeWidth } from './tree-layout';

/** 环间距（每层增加的半径） — P0(重叠修复): 180→260，给节点更大呼吸空间 */
const RING_GAP = 260;

/** 根节点中心 X */
const CENTER_X = 500;

/** 根节点中心 Y — P0: 移到更靠下的位置，避免顶部空间不足 */
const CENTER_Y = 400;

/** 最小角度间隔（弧度），避免节点过密 */
const MIN_ANGLE_GAP = 0.15;

/**
 * 计算节点的叶子数量（权重）
 * 折叠节点视为叶子
 */
function countLeaves(node: MindNode): number {
  if (node.collapsed || node.children.length === 0) return 1;
  let total = 0;
  for (const child of node.children) {
    total += countLeaves(child);
  }
  return Math.max(total, 1);
}

/**
 * 预计算所有节点的叶子数（缓存到 _leafCount）
 */
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

/**
 * 径向布局主函数
 */
export function radialLayoutTree(root: MindNode): MindNode {
  precomputeLeaves(root);

  // 根节点放在中心
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

  // 子节点均匀分布 360 度
  assignRadialLayout(root, 0, Math.PI * 2, 1);

  return root;
}

/**
 * 递归分配径向位置
 *
 * P0 修复:
 * 1. 角度分配考虑节点宽度，确保同环相邻节点弧长 >= (w1+w2)/2 + gap
 * 2. 不再跳过孙节点 — 始终递归，用自适应半径容纳所有后代
 */
function assignRadialLayout(
  node: MindNode,
  startAngle: number,
  endAngle: number,
  level: number,
): void {
  if (node.collapsed || node.children.length === 0) return;

  const radius = level * RING_GAP;
  const totalLeaves = node._leafCount ?? 1;
  const angleSpan = endAngle - startAngle;

  // P0 修复: 计算每个子节点需要的最小角度（基于宽度和当前环半径）
  const childMinAngles = node.children.map(child => {
    const w = child.renderedWidth && child.renderedWidth > 0
      ? child.renderedWidth
      : estimateNodeWidth(child);
    // 弧长 = radius * angle → angle = arcLength / radius
    // 需要的最小弧长 = 节点宽度 + 间距
    const minArc = w + 20;
    return radius > 0 ? minArc / radius : MIN_ANGLE_GAP;
  });

  // 归一化: 如果总最小角度 > 可用角度，按比例缩放（允许重叠但保证所有节点有位置）
  const totalMinAngle = childMinAngles.reduce((sum, a) => sum + a, 0);
  const angleScale = totalMinAngle > angleSpan ? angleSpan / totalMinAngle : 1;

  let currentAngle = startAngle;

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const childLeaves = child._leafCount ?? 1;
    // P0: 角度 = max(叶子数比例分配, 最小宽度角度) × 缩放
    const leafAngle = (childLeaves / totalLeaves) * angleSpan;
    const childAngleSpan = Math.max(leafAngle, childMinAngles[i]) * angleScale;
    const childAngle = currentAngle + childAngleSpan / 2;

    const childWidth = child.renderedWidth && child.renderedWidth > 0
      ? child.renderedWidth
      : estimateNodeWidth(child);
    const childHeight = getNodeHeight(child);

    const childX = CENTER_X + Math.cos(childAngle) * radius - childWidth / 2;
    const childY = CENTER_Y + Math.sin(childAngle) * radius - childHeight / 2;

    child.layout = {
      x: childX,
      y: childY,
      width: childWidth,
      height: childHeight,
    };

    // P0 修复: 始终递归子节点，不再因角度过小而跳过
    if (!child.collapsed && child.children.length > 0) {
      const margin = childAngleSpan * 0.15;
      const childStartAngle = currentAngle + margin;
      const childEndAngle = currentAngle + childAngleSpan - margin;
      // 即使扇区很小也递归 — 子节点会被放到下一环，半径更大空间更多
      assignRadialLayout(child, childStartAngle, childEndAngle, level + 1);
    }

    currentAngle += childAngleSpan;
  }
}

/**
 * 用渲染后的实际尺寸重新布局
 */
export function radialRelayoutWithMeasured(root: MindNode): MindNode {
  return radialLayoutTree(root);
}
