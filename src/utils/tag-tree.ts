/**
 * tag-tree.ts — 共享的标签树构建逻辑
 *
 * 消除 FilterBar (×2) + search-filter-bar (×1) 中 3 处重复的 buildTagTree 实现。
 *
 * 层级标签格式: "数据库/MySQL" → root node "数据库" → child "MySQL"
 */

export interface TagTreeNode {
  fullPath: string;
  label: string;
  children: TagTreeNode[];
  count: number;
}

/**
 * 从 tag 频率列表构建层级树
 * @param frequencies 标签频率列表 (name + count)
 * @returns 根节点数组 + 扁平 nodeMap
 */
export function buildTagTree(
  frequencies: Array<{ name: string; count: number }>,
): { rootNodes: TagTreeNode[]; nodeMap: Map<string, TagTreeNode> } {
  const rootNodes: TagTreeNode[] = [];
  const nodeMap = new Map<string, TagTreeNode>();

  for (const f of frequencies) {
    const parts = f.name.split('/');
    let parentList = rootNodes;
    let parentPath = '';
    for (const part of parts) {
      const currentPath = parentPath ? `${parentPath}/${part}` : part;
      let node = nodeMap.get(currentPath);
      if (!node) {
        node = { fullPath: currentPath, label: part, children: [], count: 0 };
        nodeMap.set(currentPath, node);
        parentList.push(node);
      }
      if (currentPath === f.name) node.count = f.count;
      parentList = node.children;
      parentPath = currentPath;
    }
  }

  // 递归计算父节点 count = sum(children)
  const computeCounts = (nodes: TagTreeNode[]): number => {
    let total = 0;
    for (const n of nodes) {
      const s = computeCounts(n.children);
      if (n.count === 0) n.count = s;
      total += n.count;
    }
    return total;
  };
  computeCounts(rootNodes);
  return { rootNodes, nodeMap };
}
