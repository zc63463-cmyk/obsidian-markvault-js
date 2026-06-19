/**
 * MD Parser — Markdown → MindNode 树
 *
 * 解析规则（Phase 1）：
 *   - #/##/### 标题  → 层级节点（level = # 数量）
 *   - -/* 列表项     → 列表层级节点（depth = heading depth + 1 + indent）
 *   - 正文段落       → 忽略
 *   - 代码块         → 忽略（``` 围栏内全部跳过）
 *
 * ID 规则（P0-4 修复）：md-seed 节点用 `md-{hash(text)}` 格式，
 * 基于标题/列表项文本的哈希，保证同一文本的 ID 在行号变化时仍然稳定。
 * 如果出现重复文本，追加序号：md-{hash}-2, md-{hash}-3 ...
 */

import { createMindNode, type MindNode } from '../types/mind-node';
import { logger } from '../../utils/logger';

/** 解析输入：行号 + depth，用于树构建 */
interface StackEntry {
  node: MindNode;
  depth: number;
}

/** 正则：标题行 */
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*$/;

/** 正则：列表项行（- 或 * 开头） */
const LIST_ITEM_RE = /^(\s*)([-*])\s+(.+)$/;

/** 正则：代码围栏 */
const FENCE_RE = /^```\S*$/;

/** 正则：详情块开始 <!-- mf:detail id="xxx" --> */
const DETAIL_OPEN_RE = /^<!--\s*mf:detail\s+id="([^"]+)"\s*-->\s*$/;

/** 正则：详情块结束 <!-- /mf:detail --> */
const DETAIL_CLOSE_RE = /^<!--\s*\/mf:detail\s*-->\s*$/;

/**
 * 文本哈希（djb2 变体，稳定且快速）
 * 返回 base36 字符串，截取前 8 位
 */
function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i);
    hash = hash & hash; // 保持 32 位 (intentional no-op for backward compat)
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

/**
 * 生成稳定的 MD-Seed ID
 *
 * 基于 text 的哈希，重复文本自动追加序号。
 * 同一次解析调用内维护计数器，保证 ID 唯一。
 */
function makeSeedId(text: string, idCounts: Map<string, number>): string {
  const base = `md-${hashText(text)}`;
  const count = idCounts.get(base) ?? 0;
  idCounts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

/**
 * 计算列表缩进层级
 * - Tab = 1 级
 * - 2 空格 = 1 级
 */
function countIndentLevel(indent: string): number {
  let level = 0;
  for (const ch of indent) {
    if (ch === '\t') level += 1;
    else if (ch === ' ') level += 0.5;
  }
  return Math.floor(level);
}

/**
 * 解析 Markdown 文本为 MindNode 树
 *
 * @param content Markdown 原文
 * @returns 顶层节点数组（通常只有一个根，多个时调用方需包装虚拟根）
 */
export function parseMarkdownToNodes(content: string): MindNode[] {
  const lines = content.split('\n');
  const roots: MindNode[] = [];
  const stack: StackEntry[] = [];
  let inCodeBlock = false;
  let inFrontmatter = false;
  let currentHeadingDepth = 0;

  // P0-4: ID 计数器，保证同一次解析内 ID 唯一
  const idCounts = new Map<string, number>();

  // 详情块提取: nodeId → detail text
  const detailMap = new Map<string, string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i;

    // ── frontmatter 跳过（--- ... ---） ──
    if (i === 0 && line.trim() === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === '---') {
        inFrontmatter = false;
      }
      continue;
    }

    // ── 代码围栏检测 ──
    if (FENCE_RE.test(line.trim())) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // ── 详情块检测 ──
    const detailOpen = line.match(DETAIL_OPEN_RE);
    if (detailOpen) {
      const detailId = detailOpen[1];
      const detailLines: string[] = [];
      i++; // 跳过开始行
      while (i < lines.length && !DETAIL_CLOSE_RE.test(lines[i])) {
        detailLines.push(lines[i]);
        i++;
      }
      detailMap.set(detailId, detailLines.join('\n').trim());
      continue;
    }

    // ── 标题检测 ──
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const level = headingMatch[1].length; // # 的数量
      const text = headingMatch[2].trim();
      const depth = level;
      const node = createMindNode({
        id: makeSeedId(text, idCounts),
        type: 'md-seed',
        text,
        sourceLine: lineNumber,
        sourceLevel: level,
        children: [],
      });

      // 弹出栈直到栈顶 depth < 当前 depth
      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
        stack.pop();
      }

      if (stack.length === 0) {
        roots.push(node);
      } else {
        const parent = stack[stack.length - 1].node;
        parent.children.push(node);
        node.parentId = parent.id;
      }

      stack.push({ node, depth });
      currentHeadingDepth = depth;
      continue;
    }

    // ── 列表项检测 ──
    const listMatch = line.match(LIST_ITEM_RE);
    if (listMatch) {
      const indent = listMatch[1];
      const text = listMatch[3].trim();
      const indentLevel = countIndentLevel(indent);
      const depth = currentHeadingDepth + 1 + indentLevel;

      const node = createMindNode({
        id: makeSeedId(text, idCounts),
        type: 'md-seed',
        text,
        sourceLine: lineNumber,
        sourceLevel: depth,
        children: [],
      });

      // 弹出栈直到栈顶 depth < 当前 depth
      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
        stack.pop();
      }

      if (stack.length === 0) {
        roots.push(node);
      } else {
        const parent = stack[stack.length - 1].node;
        parent.children.push(node);
        node.parentId = parent.id;
      }

      stack.push({ node, depth });
      continue;
    }

    // 其他行（正文、空行、引用等）→ 忽略
  }

  logger.debug('MDParser: parsed', roots.length, 'root(s),', countNodes(roots), 'total nodes,', detailMap.size, 'detail blocks');

  // 将 detailMap 中的内容关联到对应的 md-seed 节点 — 先构建索引 O(N), 再 O(1) 查找
  if (detailMap.size > 0) {
    const nodeIndex = new Map<string, MindNode>();
    const indexNode = (n: MindNode) => { nodeIndex.set(n.id, n); for (const c of n.children) indexNode(c); };
    for (const root of roots) indexNode(root);

    for (const [nodeId, detail] of detailMap) {
      const node = nodeIndex.get(nodeId);
      if (node) node.detail = detail;
    }
  }

  return roots;
}

/** 递归计算节点总数 */
function countNodes(nodes: MindNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    count += countNodes(node.children);
  }
  return count;
}

/**
 * 如果有多个根节点，包装为虚拟根
 * @param roots 顶层节点数组
 * @param fallbackText 虚拟根显示文本（如文件名）
 * @returns 单一根节点
 */
export function ensureSingleRoot(roots: MindNode[], fallbackText = 'Root'): MindNode {
  if (roots.length === 1) return roots[0];

  const virtualRoot = createMindNode({
    id: 'md-virtual-root',
    type: 'md-seed',
    text: fallbackText,
    children: roots,
  });
  for (const child of roots) {
    child.parentId = virtualRoot.id;
  }
  return virtualRoot;
}
