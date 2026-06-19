/**
 * Fishbone Layout — 鱼骨图（因果分析图）
 *
 * 视觉效果参考 XMind 鱼骨图：
 *
 *    [头] ───────┬──────┬──────┬────── 脊线
 *            ↙       ↙       ↘
 *       branch1  branch2  branch3
 *       ← sub1   sub2 →   ← sub3     ← depth 0: 水平展开 (远离/靠近鱼头)
 *       ↑           ↓         ↑
 *     sub1.1     sub2.1     sub3.1   ← depth 1: 垂直展开 (远离脊线)
 *       →           ←         →
 *     sub1.2     sub2.2     sub3.2   ← depth 2: 水平展开
 *
 * 算法：
 *   1. 根节点（鱼头）在左侧，水平脊线向右延伸
 *   2. 一级子节点沿脊线分布，上下交替（斜骨刺）
 *   3. 子节点方向交替：水平 → 垂直 → 水平 → 垂直 ...
 *   4. 每个子树预先计算其在展开方向上的总占位，用于兄弟间距
 */

import type { MindNode } from '../types/mind-node';
import { estimateNodeWidth, getNodeHeight } from './tree-layout';

/** 脊线起点 X（鱼头右侧） */
const SPINE_START_GAP = 60;

/** 分支沿脊线的间距 */
const BRANCH_GAP = 140;

/** 分支节点距脊线的垂直偏移 */
const BRANCH_Y_OFFSET = 80;

/** 子节点间距（垂直和水平共用） */
const SUB_GAP = 36;

/** 起点的坐标 */
const HEAD_X = 40;
const HEAD_Y = 60;

/** 获取节点宽度（优先 renderedWidth） */
function getNodeWidth(node: MindNode): number {
  return node.renderedWidth && node.renderedWidth > 0
    ? node.renderedWidth
    : estimateNodeWidth(node);
}

/**
 * 计算分支子树在水平方向的总宽度
 * 包含：节点自身宽度 + 所有可见后代在水平方向的占位
 */
function subtreeHorizontalWidth(node: MindNode, depth: number): number {
  if (node.collapsed || node.children.length === 0) {
    return getNodeWidth(node);
  }

  const isHorizontal = depth % 2 === 0; // depth 0 = 水平

  if (isHorizontal) {
    // 水平展开: 子树宽度 = 父宽 + 所有子节点子树宽度之和 + 间距
    let total = 0;
    for (let i = 0; i < node.children.length; i++) {
      total += subtreeHorizontalWidth(node.children[i], depth + 1);
      if (i < node.children.length - 1) total += SUB_GAP;
    }
    return getNodeWidth(node) + SUB_GAP + total;
  } else {
    // 垂直展开: 子树水平宽度 = max(自身, 最宽子树)
    let maxChild = 0;
    for (const child of node.children) {
      maxChild = Math.max(maxChild, subtreeHorizontalWidth(child, depth + 1));
    }
    return Math.max(getNodeWidth(node), maxChild);
  }
}

/**
 * 计算分支子树在垂直方向的总高度
 */
function subtreeVerticalHeight(node: MindNode, depth: number): number {
  if (node.collapsed || node.children.length === 0) {
    return getNodeHeight(node);
  }

  const isHorizontal = depth % 2 === 0;

  if (isHorizontal) {
    // 水平展开: 子树垂直高度 = max(自身, 最高子树)
    let maxChild = 0;
    for (const child of node.children) {
      maxChild = Math.max(maxChild, subtreeVerticalHeight(child, depth + 1));
    }
    return Math.max(getNodeHeight(node), maxChild);
  } else {
    // 垂直展开: 子树高度 = 父高 + 所有子节点子树高度之和 + 间距
    let total = 0;
    for (let i = 0; i < node.children.length; i++) {
      total += subtreeVerticalHeight(node.children[i], depth + 1);
      if (i < node.children.length - 1) total += SUB_GAP;
    }
    return getNodeHeight(node) + SUB_GAP + total;
  }
}

/**
 * 鱼骨图布局入口
 */
export function fishboneLayoutTree(root: MindNode): MindNode {
  const children = root.children;

  // 1. 放置鱼头
  const headWidth = getNodeWidth(root);
  const headHeight = getNodeHeight(root);

  root.layout = {
    x: HEAD_X,
    y: HEAD_Y - headHeight / 2,
    width: headWidth,
    height: headHeight,
  };

  if (children.length === 0) return root;

  // 2. 计算脊线范围 — 每个分支占位 = 子树水平总宽度
  const spineStartX = HEAD_X + headWidth + SPINE_START_GAP;
  const branchSpacings: number[] = children.map(c => {
    const subW = subtreeHorizontalWidth(c, 0);
    return Math.max(subW + SUB_GAP, BRANCH_GAP);
  });
  const totalSpineWidth = branchSpacings.reduce((sum, s) => sum + s, 0) - (children.length > 0 ? branchSpacings[0] / 2 : 0);
  const spineEndX = spineStartX + totalSpineWidth;

  // 3. 放置分支节点（沿脊线，上下交替）
  let branchIndex = 0;
  let cumulativeX = spineStartX;
  for (const child of children) {
    const branchSpacing = branchSpacings[branchIndex];
    const branchX = cumulativeX + branchSpacing / 2;

    const isTop = branchIndex % 2 === 0;
    const branchWidth = getNodeWidth(child);
    const branchHeight = getNodeHeight(child);
    const branchY = isTop
      ? HEAD_Y - BRANCH_Y_OFFSET - branchHeight
      : HEAD_Y + BRANCH_Y_OFFSET;

    child.layout = {
      x: branchX - branchWidth / 2,
      y: branchY,
      width: branchWidth,
      height: branchHeight,
    };

    // 4. 放置分支的子节点
    layoutFishChildren(child, isTop, 0);

    cumulativeX += branchSpacing;
    branchIndex++;
  }

  // 存储脊线信息（供 SVG 连线使用）
  root._fishboneSpine = { x1: spineStartX, y1: HEAD_Y, x2: spineEndX, y2: HEAD_Y };

  return root;
}

/**
 * 递归布局鱼骨图子节点 — 方向交替
 *
 * depth 0: 水平展开（沿脊线方向远离/靠近鱼头）
 * depth 1: 垂直展开（沿分支方向远离脊线）
 * depth 2: 水平展开
 * ...
 */
function layoutFishChildren(parent: MindNode, isTop: boolean, depth: number): void {
  if (parent.children.length === 0) return;

  if (depth % 2 === 0) {
    layoutHorizontalLayer(parent, isTop, depth);
  } else {
    layoutVerticalLayer(parent, isTop, depth);
  }
}

/**
 * 水平展开：子节点沿脊线方向（远离鱼头）水平排列
 * 每个子节点的垂直位置 = 父节点中心
 * 兄弟间距 = 各子节点的子树水平宽度 + SUB_GAP
 */
function layoutHorizontalLayer(parent: MindNode, isTop: boolean, depth: number): void {
  const parentLayout = parent.layout!;
  const parentCenterY = parentLayout.y + parentLayout.height / 2;

  // 起始 X = 父节点右侧 + 间距
  let x = parentLayout.x + parentLayout.width + SUB_GAP;

  for (const sub of parent.children) {
    const subWidth = getNodeWidth(sub);
    const subHeight = getNodeHeight(sub);

    sub.layout = {
      x,
      y: parentCenterY - subHeight / 2,
      width: subWidth,
      height: subHeight,
    };

    // 递归子节点
    if (!sub.collapsed && sub.children.length > 0) {
      layoutFishChildren(sub, isTop, depth + 1);
    }

    // 推进 X: 用子树水平宽度（含后代在水平方向的占位）
    const subTreeW = subtreeHorizontalWidth(sub, depth);
    x += subTreeW + SUB_GAP;
  }
}

/**
 * 垂直展开：子节点沿分支方向（上分支向上，下分支向下）垂直堆叠
 * 每个子节点的水平位置 = 父节点中心
 * 兄弟间距 = 各子节点的子树垂直高度 + SUB_GAP
 */
function layoutVerticalLayer(parent: MindNode, isTop: boolean, depth: number): void {
  const parentLayout = parent.layout!;
  const parentCenterX = parentLayout.x + parentLayout.width / 2;

  let y = isTop
    ? parentLayout.y - SUB_GAP - getNodeHeight(parent.children[0])
    : parentLayout.y + parentLayout.height + SUB_GAP;

  for (const sub of parent.children) {
    const subWidth = getNodeWidth(sub);
    const subHeight = getNodeHeight(sub);

    sub.layout = {
      x: parentCenterX - subWidth / 2,
      y,
      width: subWidth,
      height: subHeight,
    };

    // 递归子节点
    if (!sub.collapsed && sub.children.length > 0) {
      layoutFishChildren(sub, isTop, depth + 1);
    }

    // 推进 Y: 用子树垂直高度（含后代在垂直方向的占位）
    const subTreeH = subtreeVerticalHeight(sub, depth);
    y += (isTop ? -1 : 1) * (subTreeH + SUB_GAP);
  }
}

/**
 * 鱼骨图重布局（渲染后重新计算）
 */
export function fishboneRelayoutWithMeasured(root: MindNode): MindNode {
  return fishboneLayoutTree(root);
}
