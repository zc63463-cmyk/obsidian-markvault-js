/**
 * Timeline Layout — 时间轴布局
 *
 * 视觉效果参考 XMind 时间轴：
 *
 *   [root] ────●────────●────────●────────● ──→
 *              │        │        │        │
 *           event1   event2   event3   event4
 *              │                 │
 *            sub1              sub1
 *
 * 算法：
 *   1. 根节点在左侧
 *   2. 一级子节点沿水平轴等距分布
 *   3. 子节点的子节点上下交替堆叠
 */

import type { MindNode } from '../types/mind-node';
import { estimateNodeWidth, getNodeHeight } from './tree-layout';

/** 时间轴主轴 Y 坐标 */
const TIMELINE_Y = 200;

/** 根节点 X */
const ROOT_X = 40;

/** 一级子节点间距 — P0(重叠修复): 50→80 */
const EVENT_GAP = 80;

/** 子节点距主轴的偏移 */
const SUB_OFFSET = 50;

/** 子节点间垂直间距 */
const SUB_GAP = 24;

/**
 * 时间轴布局入口
 */
/**
 * 时间线布局入口
 *
 * H2 修复: 不再过滤折叠子节点。先为所有子节点分配 layout，
 * 再按 collapsed 决定是否布局其子节点（与 tree-layout 一致）。
 */
export function timelineLayoutTree(root: MindNode): MindNode {
  const headWidth = root.renderedWidth && root.renderedWidth > 0
    ? root.renderedWidth
    : estimateNodeWidth(root);
  const headHeight = getNodeHeight(root);

  root.layout = {
    x: ROOT_X,
    y: TIMELINE_Y - headHeight / 2,
    width: headWidth,
    height: headHeight,
  };

  const children = root.children;
  if (children.length === 0) return root;

  // 主轴起点和终点 — R7: 间距自适应节点宽度
  const axisStartX = ROOT_X + headWidth + 30;
  // R7: 每个事件占位 = max(节点宽度, EVENT_GAP) 避免重叠
  const eventSpacings: number[] = children.map(c => {
    const w = c.renderedWidth && c.renderedWidth > 0 ? c.renderedWidth : estimateNodeWidth(c);
    return Math.max(w, EVENT_GAP);
  });
  const totalWidth = eventSpacings.reduce((sum, s) => sum + s, 0) - (children.length > 0 ? eventSpacings[0] : 0);
  const axisEndX = axisStartX + totalWidth;

  let eventIndex = 0;
  let cumulativeX = axisStartX;
  for (const child of children) {
    const eventX = cumulativeX + eventSpacings[eventIndex] / 2;
    const eventWidth = child.renderedWidth && child.renderedWidth > 0
      ? child.renderedWidth
      : estimateNodeWidth(child);
    const eventHeight = getNodeHeight(child);

    // 事件节点放在轴上方或下方交替
    const isAbove = eventIndex % 2 === 0;
    const eventY = isAbove
      ? TIMELINE_Y - 30 - eventHeight
      : TIMELINE_Y + 30;

    child.layout = {
      x: eventX - eventWidth / 2,
      y: eventY,
      width: eventWidth,
      height: eventHeight,
    };

    // 子节点沿事件方向堆叠
    layoutTimelineSubNodes(child, isAbove);
    cumulativeX += eventSpacings[eventIndex];
    eventIndex++;
  }

  // 存储主轴信息
  root._timelineAxis = { x1: axisStartX, y1: TIMELINE_Y, x2: axisEndX, y2: TIMELINE_Y };

  return root;
}

/**
 * 时间轴子节点布局
 *
 * P0 修复: y 推进使用子树总高度（含后代），防止 3+ 级嵌套重叠。
 */
function layoutTimelineSubNodes(parent: MindNode, isAbove: boolean): void {
  if (parent.children.length === 0) return;

  const parentLayout = parent.layout!;
  const parentCenterX = parentLayout.x + parentLayout.width / 2;

  let y = isAbove
    ? parentLayout.y - SUB_GAP - getNodeHeight(parent.children[0])
    : parentLayout.y + parentLayout.height + SUB_GAP;

  for (const sub of parent.children) {
    const subHeight = getNodeHeight(sub);
    const subWidth = sub.renderedWidth && sub.renderedWidth > 0
      ? sub.renderedWidth
      : estimateNodeWidth(sub);

    sub.layout = {
      x: parentCenterX - subWidth / 2,
      y,
      width: subWidth,
      height: subHeight,
    };

    if (!sub.collapsed && sub.children.length > 0) {
      layoutTimelineSubNodes(sub, isAbove);
    }

    // P0 修复: 用子树总高度推进，而非单节点高度
    const subTreeHeight = timelineSubtreeHeight(sub, isAbove);
    y += (isAbove ? -1 : 1) * (subTreeHeight + SUB_GAP);
  }
}

/** P0 修复: 计算时间轴子节点的子树总高度 */
function timelineSubtreeHeight(node: MindNode, isAbove: boolean): number {
  if (node.collapsed || node.children.length === 0) {
    return getNodeHeight(node);
  }
  let total = 0;
  for (let i = 0; i < node.children.length; i++) {
    total += timelineSubtreeHeight(node.children[i], isAbove);
    if (i < node.children.length - 1) {
      total += SUB_GAP;
    }
  }
  return getNodeHeight(node) + total + SUB_GAP;
}

/**
 * 时间轴重布局
 */
export function timelineRelayoutWithMeasured(root: MindNode): MindNode {
  return timelineLayoutTree(root);
}
