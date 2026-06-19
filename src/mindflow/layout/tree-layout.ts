/**
 * Tree Layout — 右侧树形布局算法
 *
 * 布局方向：根节点在左侧，子节点向右展开
 *
 *   root ── child1 ── grandchild1
 *         └─ child2 ── grandchild2
 *
 * 算法分两遍：
 *   1. 自底向上计算每个节点的子树高度
 *   2. 自顶向下分配 x/y 坐标（父节点垂直居中于子节点跨度）
 */

import type { MindNode, NodeLayout } from '../types/mind-node';

/** 水平间距基数（实际间距 = max(parentWidth, 基数) + gap） */
export const HORIZONTAL_GAP = 220;

/** 水平层级间距 — P0(重叠修复): 40→80，对齐 markmap spacingHorizontal */
export const HORIZONTAL_EXTRA = 80;

/** 垂直间距 — P0(重叠修复): 20→28，兄弟节点间基础间隙 */
export const VERTICAL_GAP = 28;

/** 不同父节点的子树间额外间距 — P0: markmap 双倍策略，防止大子树碰撞 */
export const SUBTREE_EXTRA_GAP = 16;

/** 单行节点高度 */
export const NODE_HEIGHT = 32;

// P2-1: NODE_WIDTH 已删除（改用 estimateNodeWidth 动态估算）

/** 估算高度的常量 */
const ESTIMATE_LINE_HEIGHT = 24;
const ESTIMATE_PADDING = 16;
const ESTIMATE_MIN_HEIGHT = 40;
const ESTIMATE_BLOCK_MATH_EXTRA = 50;
const ESTIMATE_CODE_BLOCK_EXTRA = 50;

/** 根节点起始 X 坐标 */
export const ROOT_X = 40;

/** 根节点起始 Y 坐标 */
export const ROOT_Y = 40;

/** tree-left 根节点起始 X 坐标（右对齐） */
export const ROOT_X_LEFT = 800;

/**
 * 估算节点显示宽度（参考 xmind: 根据文字长度）
 *
 * P0(重叠修复): CJK 字符按 13px 计，ASCII 按 7px 计，而非全部按 7px。
 * 之前中文字符被严重低估（"向量"仅 14+28=42px，实际约需 54px），
 * 导致布局引擎分配的 X 区域不足，子节点挤在一起。
 *
 * 短文本（如"矩阵"）→ ~108px
 * 中等文本（如"行列式定义：[公式]"）→ ~200px
 * 长文本/代码块 → 由渲染后测量值替换
 */
export function estimateNodeWidth(node: MindNode): number {
  const text = node.text || '';
  let estimated = 0;
  for (const ch of text) {
    // CJK 字符和全角符号按 13px，ASCII/半角按 7px
    // 字符码范围覆盖中文、日韩、中文标点
    const code = ch.charCodeAt(0);
    const isCJK = (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0x3040 && code <= 0x30ff) // 日文假名
      || (code >= 0xac00 && code <= 0xd7af) // 韩文
      || (code >= 0xff00 && code <= 0xffef) // 全角标点
      || (code >= 0x3000 && code <= 0x303f) // 中文标点
      || (code >= 0x2000 && code <= 0x2e7f); // 通用标点/符号
    estimated += isCJK ? 13 : 7;
  }
  // padding 28px，clamp 120-500
  const result = estimated + 28;
  return Math.min(Math.max(result, 120), 500);
}

/**
 * 估算节点显示高度
 *
 * Phase 2: 节点内容支持 Markdown 渲染，高度不可预知。
 * 在异步渲染前用文本特征估算高度，渲染后用实际值替换。
 *
 * 估算规则：
 *   - 基础高度 = 行数 × 24px + 16px padding
 *   - 块级公式 $$...$$ → +50px
 *   - 代码块 ``` → +50px
 *   - 最小高度 40px
 *
 * 如果节点已有 renderedHeight（之前渲染过），直接使用缓存值。
 */
export function getNodeHeight(node: MindNode): number {
  // 优先使用渲染后的实际高度
  if (node.renderedHeight && node.renderedHeight > 0) {
    return node.renderedHeight;
  }
  return estimateNodeHeight(node);
}

/**
 * 纯估算函数（不读取缓存），用于首次布局
 */
export function estimateNodeHeight(node: MindNode): number {
  const text = node.text || '';
  const lines = text.split('\n').length;

  // 检测块级公式 $$...$$
  const hasBlockMath = /\$\$[\s\S]+?\$\$/.test(text);
  const blockMathExtra = hasBlockMath ? ESTIMATE_BLOCK_MATH_EXTRA : 0;

  // 检测代码块 ```
  const hasCodeBlock = /```[\s\S]+?```/.test(text);
  const codeBlockExtra = hasCodeBlock ? ESTIMATE_CODE_BLOCK_EXTRA : 0;

  return Math.max(
    ESTIMATE_MIN_HEIGHT,
    lines * ESTIMATE_LINE_HEIGHT + ESTIMATE_PADDING + blockMathExtra + codeBlockExtra,
  );
}

/**
 * 计算节点子树的总高度（自底向上）
 *
 * P1-5: 使用缓存避免 O(N²) 重复计算。
 * assignLayout 前先调用 precomputeSubtreeHeights 缓存所有节点高度。
 *
 * - 折叠或叶子节点 → 节点自身高度
 * - 展开节点 → max(自身高度, 所有子节点子树高度之和 + 间隙)
 */
export function calculateSubtreeHeight(node: MindNode): number {
  // P1-5: 优先使用缓存
  const cached = node._subtreeHeight;
  if (cached !== undefined) return cached;

  if (node.collapsed || node.children.length === 0) {
    return getNodeHeight(node);
  }

  let total = 0;
  for (let i = 0; i < node.children.length; i++) {
    total += calculateSubtreeHeight(node.children[i]);
    if (i < node.children.length - 1) {
      total += VERTICAL_GAP;
    }
  }

  // P0(重叠修复): 子树总高度额外加 buffer，防止大面积子树间视觉挤压
  return Math.max(getNodeHeight(node), total + SUBTREE_EXTRA_GAP * node.children.length);
}

/**
 * P1-5: 预计算所有节点的子树高度（自底向上，O(N)）
 *
 * 在 layoutTree 前调用，将结果缓存到 _subtreeHeight 字段，
 * 使 calculateSubtreeHeight 变为 O(1) 查找。
 */
export function precomputeSubtreeHeights(root: MindNode): void {
  function walk(node: MindNode): number {
    let height: number;
    if (node.collapsed || node.children.length === 0) {
      height = getNodeHeight(node);
    } else {
      let total = 0;
      for (let i = 0; i < node.children.length; i++) {
        total += walk(node.children[i]);
        if (i < node.children.length - 1) {
          total += VERTICAL_GAP;
        }
      }
      // Fix 3: 与 calculateSubtreeHeight 保持一致，加 SUBTREE_EXTRA_GAP 缓冲
      height = Math.max(getNodeHeight(node), total + SUBTREE_EXTRA_GAP * node.children.length);
    }
    node._subtreeHeight = height;
    return height;
  }
  walk(root);
}

/**
 * 自顶向下分配 x/y 坐标
 *
 * @param node 当前节点
 * @param x 当前层级 X 坐标
 * @param y 子树区域顶部 Y 坐标
 * @param direction 布局方向：'right' = 子向右, 'left' = 子向左
 */
function assignLayout(
  node: MindNode,
  x: number,
  y: number,
  direction: 'right' | 'left' = 'right',
): void {
  const subtreeHeight = calculateSubtreeHeight(node);
  const nodeHeight = getNodeHeight(node);

  // 父节点垂直居中于子节点跨度
  const nodeY = y + (subtreeHeight - nodeHeight) / 2;

  const nodeWidth = node.renderedWidth && node.renderedWidth > 0
    ? node.renderedWidth
    : estimateNodeWidth(node);

  node.layout = {
    x,
    y: nodeY,
    width: nodeWidth,
    height: nodeHeight,
  };

  if (node.collapsed || node.children.length === 0) return;

  // 子节点从子树顶部开始排列
  let childY = y;
  for (const child of node.children) {
    const childSubtreeHeight = calculateSubtreeHeight(child);
    // Fix 4: tree-left 用 renderedWidth 替代估算值，防止 X 方向穿透
    const childWidth = (child.renderedWidth && child.renderedWidth > 0)
      ? child.renderedWidth
      : estimateNodeWidth(child);
    const childX = direction === 'left'
      ? x - childWidth - HORIZONTAL_EXTRA
      : x + nodeWidth + HORIZONTAL_EXTRA;
    assignLayout(child, childX, childY, direction);
    childY += childSubtreeHeight + VERTICAL_GAP;
  }
}

/** 检查是否是可见叶子节点（用于 logic 布局的紧凑模式） */
function isVisibleLeaf(node: MindNode): boolean {
  if (node.children.length === 0) return true;
  if (node.collapsed) return false;
  return node.children.every(c => c.collapsed || c.children.length === 0);
}

/**
 * 计算逻辑图模式下节点的总 Y 占用（自身 + 所有后代）
 *
 * logic-right 布局中，同级节点紧凑排列在同一个 X 列，
 * 但每个节点的子树向右展开占用独立的 Y 空间。
 * 需要计算每个子节点的"子树总 Y"来防止叔伯节点与侄子节点重叠。
 */
/** Precompute logic-subtree heights for logic-right layout (O(N) single pass) */
function precomputeLogicSubtreeHeights(node: MindNode): number {
  if (node.collapsed || node.children.length === 0) {
    node._logicSubtreeHeight = getNodeHeight(node);
    return node._logicSubtreeHeight;
  }
  let total = 0;
  for (let i = 0; i < node.children.length; i++) {
    total += precomputeLogicSubtreeHeights(node.children[i]);
    if (i < node.children.length - 1) total += VERTICAL_GAP;
  }
  node._logicSubtreeHeight = Math.max(getNodeHeight(node), total);
  return node._logicSubtreeHeight;
}

function logicSubtreeHeight(node: MindNode): number {
  if (node._logicSubtreeHeight !== undefined) return node._logicSubtreeHeight;
  // Fallback (should not reach here after precompute)
  if (node.collapsed || node.children.length === 0) return getNodeHeight(node);
  let total = 0;
  for (let i = 0; i < node.children.length; i++) {
    total += logicSubtreeHeight(node.children[i]);
    if (i < node.children.length - 1) total += VERTICAL_GAP;
  }
  return Math.max(getNodeHeight(node), total);
}

/**
 * Logic-Right 布局：同层所有兄弟节点在同一个 X 列上（无子树垂直堆叠）
 * 适合"逻辑图"模式——同级节点紧凑排列，不按子树扩张间距
 *
 * Fix: 兄弟间距用 logicSubtreeHeight 而非 getNodeHeight，
 * 确保每个子节点的完整子树有自己的 Y 空间。
 */
function assignLogicLayout(node: MindNode, x: number, y: number): void {
  const nodeHeight = getNodeHeight(node);
  const nodeWidth = node.renderedWidth && node.renderedWidth > 0
    ? node.renderedWidth
    : estimateNodeWidth(node);

  node.layout = {
    x,
    y,
    width: nodeWidth,
    height: nodeHeight,
  };

  if (node.collapsed || node.children.length === 0) return;

  const childX = x + nodeWidth + HORIZONTAL_EXTRA;
  let childY = y;
  for (const child of node.children) {
    assignLogicLayout(child, childX, childY);
    // Fix: 用子树总高度替代节点自身高度，防止后代与叔伯节点重叠
    childY += logicSubtreeHeight(child) + VERTICAL_GAP;
  }
}

/**
 * 对整棵树执行布局（tree-right: 根左, 子向右）
 */
export function layoutTree(root: MindNode): MindNode {
  precomputeSubtreeHeights(root);
  assignLayout(root, ROOT_X, ROOT_Y, 'right');
  return root;
}

/**
 * Tree-Left 布局（根右, 子向左）
 */
export function layoutTreeLeft(root: MindNode): MindNode {
  precomputeSubtreeHeights(root);
  assignLayout(root, ROOT_X_LEFT, ROOT_Y, 'left');
  return root;
}

/**
 * Logic-Right 布局（紧凑逻辑图：同级节点不堆叠子树高度）
 */
export function layoutLogicRight(root: MindNode): MindNode {
  precomputeLogicSubtreeHeights(root);
  assignLogicLayout(root, ROOT_X, ROOT_Y);
  return root;
}

/**
 * 用渲染后的实际尺寸重新布局
 */
export function relayoutWithMeasured(root: MindNode): MindNode {
  precomputeSubtreeHeights(root);
  assignLayout(root, ROOT_X, ROOT_Y, 'right');
  return root;
}

/**
 * Tree-Left 重布局
 */
export function relayoutWithMeasuredLeft(root: MindNode): MindNode {
  precomputeSubtreeHeights(root);
  assignLayout(root, ROOT_X_LEFT, ROOT_Y, 'left');
  return root;
}

/**
 * Logic-Right 重布局
 */
export function relayoutLogicRight(root: MindNode): MindNode {
  precomputeLogicSubtreeHeights(root);
  assignLogicLayout(root, ROOT_X, ROOT_Y);
  return root;
}

/**
 * 检查节点是否需要重布局
 *
 * 比较估算高度和实际渲染高度的差异。
 *
 * @param node 节点
 * @param threshold 差异阈值（默认 8px）
 * @returns true = 需要重布局
 */
export function needsRelayout(node: MindNode, threshold: number = 8): boolean {
  if (!node.renderedHeight) return false;
  const estimated = estimateNodeHeight(node);
  return Math.abs(estimated - node.renderedHeight) > threshold;
}

/**
 * 递归检查子树中是否有节点需要重布局
 */
export function subtreeNeedsRelayout(node: MindNode, threshold: number = 8): boolean {
  if (needsRelayout(node, threshold)) return true;
  if (!node.collapsed) {
    for (const child of node.children) {
      if (subtreeNeedsRelayout(child, threshold)) return true;
    }
  }
  return false;
}

/**
 * 按 level 自动折叠深层节点
 *
 * 参考 markmap 的 initialExpandLevel 选项：
 *   - level 0 = 只显示根
 *   - level 1 = 根 + 第一层子节点
 *   - level -1 = 全部展开（默认）
 *
 * 注意：只折叠 MD-Seed 节点（有子节点且未手动展开过），
 * 不影响用户已手动设置的 collapsed 状态。
 *
 * @param root 根节点
 * @param maxLevel 最大展开层级
 */
export function applyInitialExpandLevel(root: MindNode, maxLevel: number): void {
  if (maxLevel < 0) return; // -1 = 全展开

  function walk(node: MindNode, depth: number): void {
    if (depth >= maxLevel && node.children.length > 0) {
      node.collapsed = true;
      return; // 折叠后不继续遍历
    }
    for (const child of node.children) {
      walk(child, depth + 1);
    }
  }

  walk(root, 0);
}

/**
 * 获取所有已布局节点的边界框
 */
export function getLayoutBounds(root: MindNode): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  function walk(node: MindNode): void {
    const layout = node.layout;
    if (layout) {
      minX = Math.min(minX, layout.x);
      minY = Math.min(minY, layout.y);
      maxX = Math.max(maxX, layout.x + layout.width);
      maxY = Math.max(maxY, layout.y + layout.height);
    }
    if (!node.collapsed) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  walk(root);

  if (minX === Infinity) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * 获取所有可见节点（含布局信息）
 * 折叠节点的子节点不返回
 */
export function getVisibleNodes(root: MindNode): MindNode[] {
  const result: MindNode[] = [];

  function walk(node: MindNode): void {
    result.push(node);
    if (!node.collapsed) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  walk(root);
  return result;
}

/**
 * 获取所有可见连线（父→子）
 * 折叠节点的子节点连线不返回
 */
export interface VisibleEdge {
  parent: MindNode;
  child: MindNode;
}

export function getVisibleEdges(root: MindNode): VisibleEdge[] {
  const result: VisibleEdge[] = [];

  function walk(node: MindNode): void {
    if (node.collapsed) return;
    for (const child of node.children) {
      result.push({ parent: node, child });
      walk(child);
    }
  }

  walk(root);
  return result;
}
