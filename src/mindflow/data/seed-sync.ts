/**
 * Seed-Sync — MD-Seed 单向映射
 *
 * 当 .md 文件被编辑后，重新解析 MD-Seed 节点树，
 * 同时保留 frontmatter 中的 Free 节点。
 *
 * 数据流：
 *   .md 文件内容
 *     ├─→ MD Parser → MD-Seed 节点树（只读种子）
 *     └─→ Frontmatter 读取 → Free 节点记录
 *   合并 → 完整 MindNode 树
 *
 * Free 节点保留策略：
 *   - parentId 指向仍存在的 MD-Seed → 正常挂载
 *   - parentId 指向已删除的 MD-Seed → 降级为孤儿节点（挂载根级别）
 *   - parentId 为 null → 顶层根节点
 */

import { logger } from '../../utils/logger';
import { parseMarkdownToNodes, ensureSingleRoot } from './md-parser';
import { readMindmapConfig, mergeFreeNodes } from './frontmatter-sync';
import type { MindNode, MindmapMeta } from '../types/mind-node';

/** Seed-Sync 结果 */
export interface SeedSyncResult {
  /** 合并后的根节点（已确保单一根） */
  root: MindNode;
  /** 导图元数据 */
  meta: MindmapMeta;
  /** 所有顶层节点（合并前） */
  allRoots: MindNode[];
  /** 孤儿 Free 节点数量（parentId 已失效） */
  orphanCount: number;
}

/**
 * 从 .md 文件内容构建完整的导图树
 *
 * @param content .md 文件完整内容
 * @param fallbackRootText 虚拟根显示文本（通常为文件名）
 * @returns 合并后的导图树 + 元数据
 */
export function syncFromMarkdown(content: string, fallbackRootText = 'MindMap'): SeedSyncResult {
  // 1. 解析 MD → MD-Seed 节点
  const seedRoots = parseMarkdownToNodes(content);
  logger.debug('SeedSync: parsed', seedRoots.length, 'seed root(s)');

  // 2. 读取 frontmatter → Free 节点记录 + 元数据
  const { meta, freeRecords } = readMindmapConfig(content);
  logger.debug('SeedSync: loaded', freeRecords.length, 'free node(s)');

  // 3. 合并：MD-Seed + Free → 完整树
  const allRoots = mergeFreeNodes(seedRoots, freeRecords);

  // 4. 计算孤儿数量 (L5: 构建完整 ID 集合含 free/annotation 节点)
  const allKnownIds = new Set<string>();
  for (const root of seedRoots) {
    collectIds(root, allKnownIds);
  }
  // L5: 将已合并的 free 节点 ID 也加入已知集合
  for (const record of freeRecords) {
    allKnownIds.add(record.id);
  }
  let orphanCount = 0;
  for (const record of freeRecords) {
    if (record.parentId !== null && !allKnownIds.has(record.parentId)) {
      orphanCount++;
    }
  }

  // 5. 确保单一根
  const root = ensureSingleRoot(allRoots, fallbackRootText);

  if (orphanCount > 0) {
    logger.warn(`SeedSync: ${orphanCount} free node(s) lost their parent (MD-Seed deleted)`);
  }

  return { root, meta, allRoots, orphanCount };
}

/** 递归收集所有节点 ID */
function collectIds(node: MindNode, ids: Set<string>): void {
  ids.add(node.id);
  for (const child of node.children) {
    collectIds(child, ids);
  }
}

/**
 * 在导图树中查找节点
 */
export function findNode(root: MindNode, nodeId: string): MindNode | null {
  if (root.id === nodeId) return root;
  for (const child of root.children) {
    const found = findNode(child, nodeId);
    if (found) return found;
  }
  return null;
}

/**
 * 在导图树中查找节点的父节点
 */
export function findParent(root: MindNode, nodeId: string): MindNode | null {
  for (const child of root.children) {
    if (child.id === nodeId) return root;
    const found = findParent(child, nodeId);
    if (found) return found;
  }
  return null;
}

/**
 * 递归收集所有节点（扁平化）
 */
export function flattenNodes(root: MindNode): MindNode[] {
  const result: MindNode[] = [];
  function walk(node: MindNode): void {
    result.push(node);
    for (const child of node.children) {
      walk(child);
    }
  }
  walk(root);
  return result;
}

/**
 * 查找所有用户创建的节点（free + annotation，不含 md-seed）
 *
 * L4: 扩展过滤条件包含 annotation 节点，函数名保持兼容。
 */
export function findFreeNodes(root: MindNode): MindNode[] {
  return flattenNodes(root).filter((n) => n.type === 'free' || n.type === 'annotation');
}

// ═══════════════════════════════════════════════════════
// 树操作 API（参考 mind-elixir insertSibling/removeNode/moveNode）
// ═══════════════════════════════════════════════════════

/**
 * 插入兄弟节点
 *
 * 在指定节点的同级位置插入一个新 Free 节点（紧跟其后）。
 * 根节点无兄弟（返回 null）。
 *
 * @param root 导图根
 * @param nodeId 目标节点 ID
 * @param newNode 新节点（需设置 id/text，parentId 会自动修正）
 * @returns 新节点引用，或 null 表示无法插入
 */
export function insertSibling(
  root: MindNode,
  nodeId: string,
  newNode: MindNode,
): MindNode | null {
  const parent = findParent(root, nodeId);
  if (!parent) return null; // 根节点无兄弟

  const idx = parent.children.findIndex((c) => c.id === nodeId);
  if (idx === -1) return null;

  newNode.parentId = parent.id;
  parent.children.splice(idx + 1, 0, newNode);
  return newNode;
}

/**
 * 删除节点
 *
 * 仅允许删除 Free 节点。MD-Seed 节点来自文件正文，不可删除。
 * 根节点不可删除。
 *
 * @param root 导图根
 * @param nodeId 要删除的节点 ID
 * @returns true=删除成功, false=不可删除或未找到
 */
export function removeNode(root: MindNode, nodeId: string): boolean {
  if (root.id === nodeId) return false; // 根不可删

  const node = findNode(root, nodeId);
  if (!node) return false;
  // Phase 3: free + annotation 可删，md-seed 不可删
  if (node.type === 'md-seed') return false;

  const parent = findParent(root, nodeId);
  if (!parent) return false;

  const idx = parent.children.findIndex((c) => c.id === nodeId);
  if (idx === -1) return false;

  parent.children.splice(idx, 1);
  return true;
}

/**
 * 移动节点（改变父节点）
 *
 * 将节点从当前父节点移动到新父节点下。
 * 约束：
 *   - 不能移动到自身
 *   - 不能移动到自己的后代节点（防环）
 *   - 根节点不可移动
 *
 * @param root 导图根
 * @param nodeId 要移动的节点 ID
 * @param newParentId 新父节点 ID
 * @returns true=成功, false=失败（违反约束）
 */
export function moveNode(root: MindNode, nodeId: string, newParentId: string): boolean {
  if (nodeId === newParentId) return false;
  if (root.id === nodeId) return false; // 根不可移动

  const node = findNode(root, nodeId);
  const newParent = findNode(root, newParentId);
  if (!node || !newParent) return false;

  // 防环：newParent 不能是 node 的后代
  if (isDescendant(node, newParentId)) return false;

  const oldParent = findParent(root, nodeId);
  if (!oldParent) return false;

  // 从旧父节点移除
  const idx = oldParent.children.findIndex((c) => c.id === nodeId);
  if (idx === -1) return false;
  oldParent.children.splice(idx, 1);

  // 添加到新父节点
  node.parentId = newParentId;
  newParent.children.push(node);

  return true;
}

/**
 * 检查 targetId 是否是 node 的后代节点
 */
function isDescendant(node: MindNode, targetId: string): boolean {
  for (const child of node.children) {
    if (child.id === targetId) return true;
    if (isDescendant(child, targetId)) return true;
  }
  return false;
}

/**
 * 获取节点在同级中的索引
 */
export function getNodeIndex(root: MindNode, nodeId: string): number {
  const parent = findParent(root, nodeId);
  if (!parent) return -1;
  return parent.children.findIndex((c) => c.id === nodeId);
}

/**
 * 获取节点的所有祖先 ID（从父到根）
 */
export function getAncestors(root: MindNode, nodeId: string): string[] {
  const ancestors: string[] = [];
  let current = findParent(root, nodeId);
  while (current && current.id !== root.id) {
    ancestors.push(current.id);
    current = findParent(root, current.id);
  }
  if (current && current.id === root.id) {
    ancestors.push(root.id);
  }
  return ancestors;
}
