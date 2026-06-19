/**
 * MindFlow 基础测试
 *
 * 覆盖 Phase 1 核心功能：
 *   - MD Parser: 标题/列表/正文/嵌套
 *   - Frontmatter: 读写 Free 节点 + 混合合并
 *   - Seed-Sync: MD 编辑后 Free 节点保留
 *   - Tree Layout: 坐标计算 + 折叠
 */

import { parseMarkdownToNodes, ensureSingleRoot } from '../src/mindflow/data/md-parser';
import {
  parseMindmapFrontmatter,
  writeMindmapFrontmatter,
  extractFreeNodes,
  mergeFreeNodes,
  readMindmapConfig,
  writeMindmapConfig,
} from '../src/mindflow/data/frontmatter-sync';
import { syncFromMarkdown, findNode } from '../src/mindflow/data/seed-sync';
import {
  layoutTree,
  getVisibleNodes,
  getVisibleEdges,
  getLayoutBounds,
  HORIZONTAL_GAP,
  NODE_HEIGHT,
  VERTICAL_GAP,
  HORIZONTAL_EXTRA,
} from '../src/mindflow/layout/tree-layout';
import {
  createMindNode,
  DEFAULT_STRUCTURE_TYPE,
  DEFAULT_LAYOUT_TYPE,
  fromFreeNodeRecord,
  type MindNode,
  type FreeNodeRecord,
  type MindmapMeta,
} from '../src/mindflow/types/mind-node';

let pass = 0;
let fail = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    pass++;
  } catch (err: any) {
    console.log(`  ❌ ${name}: ${err.message}`);
    fail++;
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: any, expected: any, label = '') {
  if (actual !== expected) throw new Error(`${label} expected ${expected}, got ${actual}`);
}

// ═══════════════════════════════════════════════════════
// MD Parser 测试
// ═══════════════════════════════════════════════════════

async function testMDParser() {
  console.log('\n── MD Parser ──');

  await test('# 标题 → level 1 root node', () => {
    const roots = parseMarkdownToNodes('# My Title\n');
    assertEqual(roots.length, 1, 'root count');
    assertEqual(roots[0].type, 'md-seed', 'type');
    assertEqual(roots[0].text, 'My Title', 'text');
    assertEqual(roots[0].parentId, null, 'parentId');
    assertEqual(roots[0].sourceLevel, 1, 'sourceLevel');
  });

  await test('## 标题 → level 2 child node', () => {
    const roots = parseMarkdownToNodes('# Title\n## Subtitle\n');
    assertEqual(roots.length, 1, 'root count');
    assertEqual(roots[0].children.length, 1, 'child count');
    const child = roots[0].children[0];
    assertEqual(child.text, 'Subtitle', 'child text');
    assertEqual(child.sourceLevel, 2, 'child level');
    assertEqual(child.parentId, roots[0].id, 'child parentId');
  });

  await test('- 列表项 → list node', () => {
    const roots = parseMarkdownToNodes('# Title\n- Item 1\n- Item 2\n');
    assertEqual(roots[0].children.length, 2, 'list item count');
    assertEqual(roots[0].children[0].text, 'Item 1', 'item 1 text');
    assertEqual(roots[0].children[1].text, 'Item 2', 'item 2 text');
  });

  await test('正文段落 → 不生成节点', () => {
    const roots = parseMarkdownToNodes('# Title\n\nThis is a paragraph.\n\nAnother paragraph.\n');
    assertEqual(roots.length, 1, 'root count');
    assertEqual(roots[0].children.length, 0, 'no children from paragraphs');
  });

  await test('代码块 → 不生成节点', () => {
    const content = '# Title\n\n```js\nconst x = 1;\n- not a list\n```\n\n- real item\n';
    const roots = parseMarkdownToNodes(content);
    assertEqual(roots[0].children.length, 1, 'only 1 child (real item)');
    assertEqual(roots[0].children[0].text, 'real item', 'child text');
  });

  await test('嵌套列表 → 正确的父子关系', () => {
    const content = '# Title\n- Parent\n  - Child A\n  - Child B\n- Sibling\n';
    const roots = parseMarkdownToNodes(content);
    assertEqual(roots[0].children.length, 2, 'top-level list items');

    const parent = roots[0].children[0];
    assertEqual(parent.text, 'Parent', 'parent text');
    assertEqual(parent.children.length, 2, 'nested children count');
    assertEqual(parent.children[0].text, 'Child A', 'child A text');
    assertEqual(parent.children[1].text, 'Child B', 'child B text');

    const sibling = roots[0].children[1];
    assertEqual(sibling.text, 'Sibling', 'sibling text');
    assertEqual(sibling.children.length, 0, 'sibling has no children');
  });

  await test('三级标题嵌套 → 正确层级', () => {
    const content = '# H1\n## H2\n### H3\n';
    const roots = parseMarkdownToNodes(content);
    assertEqual(roots.length, 1, 'root count');
    assertEqual(roots[0].children[0].text, 'H2', 'H2 text');
    assertEqual(roots[0].children[0].children[0].text, 'H3', 'H3 text');
    assertEqual(
      roots[0].children[0].children[0].parentId,
      roots[0].children[0].id,
      'H3 parentId = H2 id',
    );
  });

  await test('ensureSingleRoot: 多根 → 虚拟根', () => {
    const roots = parseMarkdownToNodes('# A\n# B\n');
    assertEqual(roots.length, 2, 'two roots');
    const root = ensureSingleRoot(roots, 'Virtual');
    assertEqual(root.text, 'Virtual', 'virtual root text');
    assertEqual(root.children.length, 2, 'virtual root children');
  });
}

// ═══════════════════════════════════════════════════════
// Frontmatter 测试
// ═══════════════════════════════════════════════════════

async function testFrontmatter() {
  console.log('\n── Frontmatter 读写 ──');

  await test('写入 Free 节点 → frontmatter 正确', () => {
    const meta: MindmapMeta = {
      structureType: 'skeleton',
      layout: 'tree-right',
    };
    const freeNodes: FreeNodeRecord[] = [
      { id: 'free-1', parentId: 'md-3xi5mv', text: 'Manual node', note: 'a note' },
    ];

    const result = writeMindmapFrontmatter('# Title\n', meta, freeNodes);
    assert(result.includes('mindmap:'), 'has mindmap section');
    assert(result.includes('structureType: skeleton'), 'has structureType');
    assert(result.includes('layout: tree-right'), 'has layout');
    assert(result.includes('id: free-1'), 'has node id');
    assert(result.includes('text: Manual node'), 'has node text');
    assert(result.includes('# Title'), 'preserves body');
  });

  await test('读取 Free 节点 → 还原 MindNode', () => {
    const content = `---
mindmap:
  structureType: flow
  layout: tree-right
  nodes:
    - id: free-1
      parentId: md-0
      text: Test Node
      note: test note
---
# Title
`;
    const fm = parseMindmapFrontmatter(content);
    assert(fm !== null, 'frontmatter parsed');
    assertEqual(fm!.structureType, 'flow', 'structureType');
    assertEqual(fm!.layout, 'tree-right', 'layout');
    assertEqual(fm!.nodes!.length, 1, 'node count');
    assertEqual(fm!.nodes![0].id, 'free-1', 'node id');
    assertEqual(fm!.nodes![0].parentId, 'md-0', 'node parentId');
    assertEqual(fm!.nodes![0].text, 'Test Node', 'node text');
    assertEqual(fm!.nodes![0].note, 'test note', 'node note');
  });

  await test('无 frontmatter → 返回 null', () => {
    const content = '# Title\nNo frontmatter here\n';
    const fm = parseMindmapFrontmatter(content);
    assertEqual(fm, null, 'should be null');
  });

  await test('readMindmapConfig: 默认值', () => {
    const content = '# Title\n';
    const config = readMindmapConfig(content);
    assertEqual(config.meta.structureType, DEFAULT_STRUCTURE_TYPE, 'default structureType');
    assertEqual(config.meta.layout, DEFAULT_LAYOUT_TYPE, 'default layout');
    assertEqual(config.freeRecords.length, 0, 'no free nodes');
  });

  await test('混合 MD-Seed + Free → 合并为完整树', () => {
    // 先解析 MD-Seed
    const seedRoots = parseMarkdownToNodes('# Title\n## Sub\n');
    assertEqual(seedRoots[0].children.length, 1, 'seed has 1 child');

    // 创建 Free 节点记录（挂载到 Sub 下）
    const freeRecords: FreeNodeRecord[] = [
      { id: 'free-1', parentId: seedRoots[0].children[0].id, text: 'Free under Sub' },
    ];

    // 合并
    const merged = mergeFreeNodes(seedRoots, freeRecords);
    assertEqual(merged.length, 1, 'still 1 root');
    const subNode = merged[0].children[0];
    assertEqual(subNode.children.length, 1, 'Sub now has 1 child (Free)');
    assertEqual(subNode.children[0].type, 'free', 'child is free type');
    assertEqual(subNode.children[0].text, 'Free under Sub', 'free text');
  });

  await test('writeMindmapConfig: 往返一致性', () => {
    const original = '# Title\n## Sub\n';
    const meta: MindmapMeta = { structureType: 'skeleton', layout: 'tree-right' };

    // 构建一棵带 Free 节点的树
    const roots = parseMarkdownToNodes(original);
    const freeNode = createMindNode({
      id: 'free-1',
      type: 'free',
      parentId: roots[0].children[0].id,
      text: 'Free node',
      children: [],
    });
    roots[0].children[0].children.push(freeNode);

    // 写入
    const written = writeMindmapConfig(original, meta, roots);

    // 读回
    const config = readMindmapConfig(written);
    assertEqual(config.freeRecords.length, 1, '1 free node round-tripped');
    assertEqual(config.freeRecords[0].id, 'free-1', 'free id preserved');
    assertEqual(config.freeRecords[0].text, 'Free node', 'free text preserved');
  });

  await test('保留原有 frontmatter 字段', () => {
    const content = `---
title: My Note
tags:
  - math
  - algebra
mindmap:
  structureType: skeleton
  layout: tree-right
---
# Title
`;
    const written = writeMindmapConfig(content, { structureType: 'flow', layout: 'tree-right' }, []);
    assert(written.includes('title: My Note'), 'preserves title');
    assert(written.includes('tags:'), 'preserves tags');
    assert(written.includes('structureType: flow'), 'updates mindmap');
    assert(written.includes('# Title'), 'preserves body');
  });
}

// ═══════════════════════════════════════════════════════
// Seed-Sync 测试
// ═══════════════════════════════════════════════════════

async function testSeedSync() {
  console.log('\n── Seed-Sync ──');

  await test('MD 编辑 → 重新解析 → Free 节点保留', () => {
    // P0-4: ID 现在基于文本哈希，不再依赖行号
    // H1 → md-3hnem, H2 → md-3hnen
    const original = `---
mindmap:
  structureType: skeleton
  layout: tree-right
  nodes:
    - id: free-1
      parentId: md-3hnen
      text: Free under H2
---
# H1
## H2
`;
    const result1 = syncFromMarkdown(original, 'Test');

    // 验证 Free 节点已挂载
    const h2Node = findNode(result1.root, 'md-3hnen');
    assert(h2Node !== null, 'H2 node found');
    assertEqual(h2Node!.children.length, 1, 'H2 has Free child');
    assertEqual(h2Node!.children[0].type, 'free', 'child is free');
    assertEqual(h2Node!.children[0].text, 'Free under H2', 'free text');

    // 模拟 MD 编辑：在 H2 后添加 H3（H2 文本不变 → ID 不变）
    const edited = `---
mindmap:
  structureType: skeleton
  layout: tree-right
  nodes:
    - id: free-1
      parentId: md-3hnen
      text: Free under H2
---
# H1
## H2
### H3
`;
    const result2 = syncFromMarkdown(edited, 'Test');
    const h2Node2 = findNode(result2.root, 'md-3hnen');
    assert(h2Node2 !== null, 'H2 still found after edit');
    assertEqual(h2Node2!.children.length, 2, 'H2 now has 2 children (H3 + Free)');

    // Free 节点仍在
    const freeChild = h2Node2!.children.find((c) => c.type === 'free');
    assert(freeChild !== undefined, 'Free node preserved');
    assertEqual(freeChild!.text, 'Free under H2', 'free text preserved');
  });

  await test('MD 删除父节点 → Free 节点降级为孤儿', () => {
    // H2 → md-3hnen
    const original = `---
mindmap:
  structureType: skeleton
  layout: tree-right
  nodes:
    - id: free-1
      parentId: md-3hnen
      text: Orphaned Free
---
# H1
## H2
`;
    // 删除 H2 行
    const edited = `---
mindmap:
  structureType: skeleton
  layout: tree-right
  nodes:
    - id: free-1
      parentId: md-3hnen
      text: Orphaned Free
---
# H1
`;
    const result = syncFromMarkdown(edited, 'Test');
    assertEqual(result.orphanCount, 1, '1 orphan detected');
    // 孤儿节点应出现在顶层
    const allRoots = result.allRoots;
    const orphan = allRoots.find((n) => n.id === 'free-1');
    assert(orphan !== undefined, 'orphan found in roots');
  });

  await test('syncFromMarkdown: 空文件', () => {
    const result = syncFromMarkdown('', 'Empty');
    assert(result.root !== null, 'root exists');
    assertEqual(result.root.text, 'Empty', 'root text is fallback');
  });
}

// ═══════════════════════════════════════════════════════
// Tree Layout 测试
// ═══════════════════════════════════════════════════════

async function testTreeLayout() {
  console.log('\n── Tree Layout ──');

  await test('单根树 → 正确的 x/y 位置', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      children: [
        createMindNode({ id: 'c1', type: 'md-seed', text: 'Child 1', children: [] }),
        createMindNode({ id: 'c2', type: 'md-seed', text: 'Child 2', children: [] }),
      ],
    });
    root.children[0].parentId = root.id;
    root.children[1].parentId = root.id;

    layoutTree(root);

    // 根节点有 layout
    assert(root.layout !== undefined, 'root has layout');
    assertEqual(root.layout!.x, 40, 'root x'); // ROOT_X

    // 子节点 x = root.x + rootWidth + HORIZONTAL_EXTRA (P2-8: 自适应宽度)
    const expectedChildX = 40 + root.layout!.width + HORIZONTAL_EXTRA;
    assertEqual(root.children[0].layout!.x, expectedChildX, 'child 1 x');
    assertEqual(root.children[1].layout!.x, expectedChildX, 'child 2 x');

    // 两个子节点 y 不同
    assert(
      root.children[0].layout!.y !== root.children[1].layout!.y,
      'children have different y',
    );
  });

  await test('折叠节点 → children 不参与布局', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      collapsed: true,
      children: [
        createMindNode({ id: 'c1', type: 'md-seed', text: 'Child 1', children: [] }),
        createMindNode({ id: 'c2', type: 'md-seed', text: 'Child 2', children: [] }),
      ],
    });

    layoutTree(root);

    // 折叠的子节点不应有 layout
    assertEqual(root.children[0].layout, undefined, 'child 1 has no layout');
    assertEqual(root.children[1].layout, undefined, 'child 2 has no layout');

    // 可见节点只有根
    const visible = getVisibleNodes(root);
    assertEqual(visible.length, 1, 'only root is visible');

    // 可见连线为空
    const edges = getVisibleEdges(root);
    assertEqual(edges.length, 0, 'no visible edges');
  });

  await test('展开节点 → 所有子节点可见', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      children: [
        createMindNode({
          id: 'c1',
          type: 'md-seed',
          text: 'Child 1',
          children: [
            createMindNode({ id: 'g1', type: 'md-seed', text: 'Grandchild', children: [] }),
          ],
        }),
        createMindNode({ id: 'c2', type: 'md-seed', text: 'Child 2', children: [] }),
      ],
    });
    root.children[0].parentId = root.id;
    root.children[1].parentId = root.id;
    root.children[0].children[0].parentId = root.children[0].id;

    layoutTree(root);

    const visible = getVisibleNodes(root);
    assertEqual(visible.length, 4, 'all 4 nodes visible');

    const edges = getVisibleEdges(root);
    assertEqual(edges.length, 3, '3 edges visible');
  });

  await test('getLayoutBounds: 正确计算边界', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      children: [
        createMindNode({ id: 'c1', type: 'md-seed', text: 'Child 1', children: [] }),
      ],
    });
    root.children[0].parentId = root.id;

    layoutTree(root);
    const bounds = getLayoutBounds(root);

    assert(bounds.width > 0, 'width > 0');
    assert(bounds.height > 0, 'height > 0');
    assert(bounds.maxX > bounds.minX, 'maxX > minX');
    assert(bounds.maxY > bounds.minY, 'maxY > minY');
  });

  await test('深层嵌套 → x 坐标递增', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'L0',
      children: [
        createMindNode({
          id: 'l1',
          type: 'md-seed',
          text: 'L1',
          children: [
            createMindNode({
              id: 'l2',
              type: 'md-seed',
              text: 'L2',
              children: [
                createMindNode({ id: 'l3', type: 'md-seed', text: 'L3', children: [] }),
              ],
            }),
          ],
        }),
      ],
    });
    root.children[0].parentId = root.id;
    root.children[0].children[0].parentId = root.children[0].id;
    root.children[0].children[0].children[0].parentId = root.children[0].children[0].id;

    layoutTree(root);

    const l0 = root.layout!.x;
    const l1 = root.children[0].layout!.x;
    const l2 = root.children[0].children[0].layout!.x;
    const l3 = root.children[0].children[0].children[0].layout!.x;

    assert(l1 > l0, 'L1 x > L0 x');
    assert(l2 > l1, 'L2 x > L1 x');
    assert(l3 > l2, 'L3 x > L2 x');
    // P2-8: 间距自适应，不再固定 HORIZONTAL_GAP
    assert(l3 - l0 > 100, 'total x span > 100 (adaptive gaps)');
  });
}

// ═══════════════════════════════════════════════════════
// Phase 1.5 增强：树操作 + 初始折叠 + EventBus + UndoRedo
// ═══════════════════════════════════════════════════════

async function testTreeOperations() {
  console.log('\n── Phase 1.5: 树操作 ──');

  const { insertSibling, removeNode, moveNode, findParent, getAncestors } =
    await import('../src/mindflow/data/seed-sync');

  await test('insertSibling: 在节点后插入兄弟', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      children: [
        createMindNode({ id: 'c1', type: 'md-seed', text: 'C1', parentId: 'root', children: [] }),
        createMindNode({ id: 'c2', type: 'md-seed', text: 'C2', parentId: 'root', children: [] }),
      ],
    });

    const newSibling = createMindNode({
      id: 's1',
      type: 'free',
      text: 'Sibling',
      children: [],
    });

    const result = insertSibling(root, 'c1', newSibling);
    assert(result !== null, 'insert succeeded');
    assertEqual(root.children.length, 3, '3 children now');
    assertEqual(root.children[1].id, 's1', 'sibling inserted after c1');
    assertEqual(root.children[1].parentId, 'root', 'parentId set');
  });

  await test('insertSibling: 根节点无兄弟 → 返回 null', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      children: [],
    });
    const result = insertSibling(root, 'root', createMindNode({ id: 'x', type: 'free', text: 'x', children: [] }));
    assertEqual(result, null, 'root has no sibling');
  });

  await test('removeNode: 删除 Free 节点', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      children: [
        createMindNode({ id: 'f1', type: 'free', text: 'Free', parentId: 'root', children: [] }),
      ],
    });

    const ok = removeNode(root, 'f1');
    assert(ok, 'removed successfully');
    assertEqual(root.children.length, 0, 'no children after remove');
  });

  await test('removeNode: MD-Seed 不可删除', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      children: [
        createMindNode({ id: 's1', type: 'md-seed', text: 'Seed', parentId: 'root', children: [] }),
      ],
    });

    const ok = removeNode(root, 's1');
    assert(!ok, 'md-seed cannot be removed');
    assertEqual(root.children.length, 1, 'child still there');
  });

  await test('removeNode: 根节点不可删除', () => {
    const root = createMindNode({ id: 'root', type: 'md-seed', text: 'Root', children: [] });
    const ok = removeNode(root, 'root');
    assert(!ok, 'root cannot be removed');
  });

  await test('moveNode: 移动到新父节点', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      children: [
        createMindNode({
          id: 'a',
          type: 'md-seed',
          text: 'A',
          parentId: 'root',
          children: [
            createMindNode({ id: 'f1', type: 'free', text: 'F1', parentId: 'a', children: [] }),
          ],
        }),
        createMindNode({ id: 'b', type: 'md-seed', text: 'B', parentId: 'root', children: [] }),
      ],
    });

    const ok = moveNode(root, 'f1', 'b');
    assert(ok, 'move succeeded');
    assertEqual(root.children[0].children.length, 0, 'A has no children now');
    assertEqual(root.children[1].children.length, 1, 'B has f1 now');
    assertEqual(root.children[1].children[0].id, 'f1', 'f1 under B');
    assertEqual(root.children[1].children[0].parentId, 'b', 'parentId updated');
  });

  await test('moveNode: 不能移动到自身', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      children: [
        createMindNode({ id: 'f1', type: 'free', text: 'F1', parentId: 'root', children: [] }),
      ],
    });
    const ok = moveNode(root, 'f1', 'f1');
    assert(!ok, 'cannot move to self');
  });

  await test('moveNode: 不能移动到后代（防环）', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      children: [
        createMindNode({
          id: 'a',
          type: 'md-seed',
          text: 'A',
          parentId: 'root',
          children: [
            createMindNode({
              id: 'b',
              type: 'md-seed',
              text: 'B',
              parentId: 'a',
              children: [
                createMindNode({ id: 'f1', type: 'free', text: 'F1', parentId: 'b', children: [] }),
              ],
            }),
          ],
        }),
      ],
    });

    // 尝试把 A 移到 F1（F1 是 A 的后代）→ 应失败
    const ok = moveNode(root, 'a', 'f1');
    assert(!ok, 'cannot move to descendant');
  });

  await test('getAncestors: 获取祖先链', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      children: [
        createMindNode({
          id: 'a',
          type: 'md-seed',
          text: 'A',
          parentId: 'root',
          children: [
            createMindNode({ id: 'b', type: 'md-seed', text: 'B', parentId: 'a', children: [] }),
          ],
        }),
      ],
    });

    const ancestors = getAncestors(root, 'b');
    assertEqual(ancestors.length, 2, '2 ancestors (a, root)');
    assertEqual(ancestors[0], 'a', 'first ancestor is a');
    assertEqual(ancestors[1], 'root', 'second ancestor is root');
  });
}

async function testInitialExpandLevel() {
  console.log('\n── Phase 1.5: 初始折叠 ──');

  const { applyInitialExpandLevel } = await import('../src/mindflow/layout/tree-layout');

  await test('applyInitialExpandLevel(1): 只展开第一层', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      children: [
        createMindNode({
          id: 'c1',
          type: 'md-seed',
          text: 'C1',
          children: [
            createMindNode({ id: 'g1', type: 'md-seed', text: 'G1', children: [] }),
          ],
        }),
      ],
    });
    root.children[0].parentId = root.id;
    root.children[0].children[0].parentId = root.children[0].id;

    applyInitialExpandLevel(root, 1);

    assert(root.collapsed !== true, 'root not collapsed');
    assert(root.children[0].collapsed === true, 'c1 collapsed (depth 1 >= maxLevel 1)');
  });

  await test('applyInitialExpandLevel(-1): 全部展开', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      children: [
        createMindNode({
          id: 'c1',
          type: 'md-seed',
          text: 'C1',
          children: [
            createMindNode({ id: 'g1', type: 'md-seed', text: 'G1', children: [] }),
          ],
        }),
      ],
    });
    root.children[0].parentId = root.id;
    root.children[0].children[0].parentId = root.children[0].id;

    applyInitialExpandLevel(root, -1);

    assert(root.collapsed !== true, 'root expanded');
    assert(root.children[0].collapsed !== true, 'c1 expanded');
  });

  await test('applyInitialExpandLevel(0): 只显示根', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      children: [
        createMindNode({ id: 'c1', type: 'md-seed', text: 'C1', children: [] }),
      ],
    });
    root.children[0].parentId = root.id;

    applyInitialExpandLevel(root, 0);

    assert(root.collapsed === true, 'root collapsed');
  });
}

async function testEventBus() {
  console.log('\n── Phase 1.5: EventBus ──');

  const { MindflowEventBus } = await import('../src/mindflow/core/event-bus');

  await test('on/emit: 事件订阅和广播', () => {
    const bus = new MindflowEventBus();
    const received: string[] = [];

    bus.on('operation', (e) => {
      received.push(e.name);
    });

    bus.emit('operation', { name: 'insertChild', nodeId: 'n1' });
    bus.emit('operation', { name: 'removeNode', nodeId: 'n2' });

    assertEqual(received.length, 2, '2 events received');
    assertEqual(received[0], 'insertChild', 'first event');
    assertEqual(received[1], 'removeNode', 'second event');
  });

  await test('on/emit: 多个监听器', () => {
    const bus = new MindflowEventBus();
    let count = 0;

    bus.on('select', () => count++);
    bus.on('select', () => count++);

    bus.emit('select', { nodeId: 'x' });

    assertEqual(count, 2, 'both listeners called');
  });

  await test('取消订阅', () => {
    const bus = new MindflowEventBus();
    let count = 0;

    const unsub = bus.on('collapse', () => count++);
    bus.emit('collapse', { nodeId: 'x', collapsed: true });
    assertEqual(count, 1, 'called before unsubscribe');

    unsub();
    bus.emit('collapse', { nodeId: 'x', collapsed: false });
    assertEqual(count, 1, 'not called after unsubscribe');
  });

  await test('监听器异常不影响其他监听器', () => {
    const bus = new MindflowEventBus();
    let called = false;

    bus.on('view', () => {
      throw new Error('listener error');
    });
    bus.on('view', () => {
      called = true;
    });

    bus.emit('view', { type: 'fit' });
    assert(called, 'second listener still called');
  });

  await test('clear: 清除所有监听器', () => {
    const bus = new MindflowEventBus();
    let count = 0;

    bus.on('select', () => count++);
    bus.clear();
    bus.emit('select', { nodeId: 'x' });

    assertEqual(count, 0, 'no listeners after clear');
  });
}

async function testUndoRedo() {
  console.log('\n── Phase 1.5: Undo/Redo ──');

  const { UndoRedoManager } = await import('../src/mindflow/core/undo-redo');

  await test('snapshot + undo: 回滚到上一个状态', () => {
    const mgr = new UndoRedoManager();
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      children: [
        createMindNode({ id: 'f1', type: 'free', text: 'F1', parentId: 'root', children: [] }),
      ],
    });
    const meta: MindmapMeta = { structureType: 'skeleton', layout: 'tree-right' };

    // 快照1：操作前
    mgr.snapshot('before add', root, meta);

    // 执行操作：添加 f2
    root.children.push(createMindNode({ id: 'f2', type: 'free', text: 'F2', parentId: 'root', children: [] }));
    assertEqual(root.children.length, 2, '2 children after add');

    // 撤销
    const snap = mgr.undo({ root, meta });
    assert(snap !== null, 'undo returned snapshot');
    assertEqual(snap!.freeRecords.length, 1, 'snapshot has 1 free record (before add)');
    assertEqual(snap!.freeRecords[0].id, 'f1', 'snapshot has f1');
  });

  await test('redo: 重做', () => {
    const mgr = new UndoRedoManager();
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      children: [],
    });
    const meta: MindmapMeta = { structureType: 'skeleton', layout: 'tree-right' };

    mgr.snapshot('before', root, meta);
    root.children.push(createMindNode({ id: 'f1', type: 'free', text: 'F1', parentId: 'root', children: [] }));

    // undo
    mgr.undo({ root, meta });
    assert(!mgr.canUndo() || mgr.canRedo(), 'can redo after undo');

    // redo
    const snap = mgr.redo({ root, meta });
    assert(snap !== null, 'redo returned snapshot');
    assertEqual(snap!.freeRecords.length, 1, 'redo restores f1');
  });

  await test('canUndo/canRedo: 初始状态', () => {
    const mgr = new UndoRedoManager();
    assert(!mgr.canUndo(), 'cannot undo initially');
    assert(!mgr.canRedo(), 'cannot redo initially');
  });

  await test('新操作清空 redo 栈', () => {
    const mgr = new UndoRedoManager();
    const root = createMindNode({ id: 'root', type: 'md-seed', text: 'Root', children: [] });
    const meta: MindmapMeta = { structureType: 'skeleton', layout: 'tree-right' };

    mgr.snapshot('op1', root, meta);
    mgr.undo({ root, meta });
    assert(mgr.canRedo(), 'can redo after undo');

    // 新操作 → redo 应清空
    mgr.snapshot('op2', root, meta);
    assert(!mgr.canRedo(), 'redo cleared after new operation');
  });

  await test('栈溢出保护（MAX_STACK=50）', () => {
    const mgr = new UndoRedoManager();
    const root = createMindNode({ id: 'root', type: 'md-seed', text: 'Root', children: [] });
    const meta: MindmapMeta = { structureType: 'skeleton', layout: 'tree-right' };

    // 压入 60 个快照
    for (let i = 0; i < 60; i++) {
      mgr.snapshot(`op${i}`, root, meta);
    }

    // 深度不应超过 50
    const depth = mgr.getDepth();
    assert(depth.undo <= 50, `undo stack <= 50 (got ${depth.undo})`);
  });
}

// ═══════════════════════════════════════════════════════
// 主函数
// ═══════════════════════════════════════════════════════

async function testPhase2Layout() {
  console.log('\n── Phase 2: 估算高度 + 重布局 ──');

  const { estimateNodeHeight, relayoutWithMeasured, needsRelayout, subtreeNeedsRelayout } =
    await import('../src/mindflow/layout/tree-layout');
  const { RenderCache } = await import('../src/mindflow/render/render-cache');

  await test('estimateNodeHeight: 纯文本单行', () => {
    const node = createMindNode({ id: 'n1', type: 'free', text: 'Hello', children: [] });
    const h = estimateNodeHeight(node);
    assert(h >= 40, 'min height 40');
  });

  await test('estimateNodeHeight: 多行文本', () => {
    const node = createMindNode({
      id: 'n1',
      type: 'free',
      text: 'Line 1\nLine 2\nLine 3',
      children: [],
    });
    const h = estimateNodeHeight(node);
    assert(h > 40, 'multi-line > 40');
    // 3 lines × 24 + 16 padding = 88
    assertEqual(h, 88, '3 lines = 88px');
  });

  await test('estimateNodeHeight: 含块级公式', () => {
    const node = createMindNode({
      id: 'n1',
      type: 'free',
      text: 'Formula:\n$$E=mc^2$$',
      children: [],
    });
    const h = estimateNodeHeight(node);
    // 2 lines × 24 + 16 + 50 math = 114
    assert(h > 88, 'block math adds height');
  });

  await test('estimateNodeHeight: 含代码块', () => {
    const node = createMindNode({
      id: 'n1',
      type: 'free',
      text: 'Code:\n```\nconst x = 1;\n```',
      children: [],
    });
    const h = estimateNodeHeight(node);
    assert(h > 88, 'code block adds height');
  });

  await test('getNodeHeight: 优先使用 renderedHeight', () => {
    const { getNodeHeight } = require('../src/mindflow/layout/tree-layout');
    const node = createMindNode({
      id: 'n1',
      type: 'free',
      text: 'Short',
      renderedHeight: 200,
      children: [],
    });
    const h = getNodeHeight(node);
    assertEqual(h, 200, 'uses renderedHeight cache');
  });

  await test('getNodeHeight: 无缓存时用估算', () => {
    const { getNodeHeight } = require('../src/mindflow/layout/tree-layout');
    const node = createMindNode({
      id: 'n1',
      type: 'free',
      text: 'Short',
      children: [],
    });
    const h = getNodeHeight(node);
    assert(h >= 40, 'uses estimate');
  });

  await test('relayoutWithMeasured: 用 renderedHeight 重布局', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      renderedHeight: 60,
      children: [
        createMindNode({
          id: 'c1',
          type: 'free',
          text: 'Child 1',
          renderedHeight: 80,
          parentId: 'root',
          children: [],
        }),
      ],
    });

    relayoutWithMeasured(root);

    assert(root.layout !== undefined, 'root has layout');
    assertEqual(root.layout!.height, 60, 'root height = renderedHeight');
    assertEqual(root.children[0].layout!.height, 80, 'child height = renderedHeight');
  });

  await test('needsRelayout: 估算与实际差异检测', () => {
    const node = createMindNode({
      id: 'n1',
      type: 'free',
      text: 'Short text',
      renderedHeight: 100, // actual 100, estimated ~40
      children: [],
    });
    assert(needsRelayout(node, 8), 'needs relayout (diff > 8)');

    const node2 = createMindNode({
      id: 'n2',
      type: 'free',
      text: 'Short',
      renderedHeight: 42, // actual 42, estimated 40 → diff 2
      children: [],
    });
    assert(!needsRelayout(node2, 8), 'no relayout needed (diff < 8)');
  });

  await test('RenderCache: 基本读写', () => {
    const cache = new RenderCache();
    assert(!cache.has('n1', 'hello'), 'not cached initially');

    cache.set('n1', 'hello', '<p>hello</p>', 40, 160);
    assert(cache.has('n1', 'hello'), 'cached after set');

    const entry = cache.get('n1', 'hello');
    assert(entry !== null, 'entry exists');
    assertEqual(entry!.html, '<p>hello</p>', 'html');
    assertEqual(entry!.height, 40, 'height');
  });

  await test('RenderCache: text 变化 → 缓存未命中', () => {
    const cache = new RenderCache();
    cache.set('n1', 'old text', '<p>old</p>', 40, 160);

    assert(!cache.has('n1', 'new text'), 'miss when text changes');
    assert(cache.has('n1', 'old text'), 'hit for old text');
  });

  await test('RenderCache: clear 清空', () => {
    const cache = new RenderCache();
    cache.set('n1', 'a', '<p>a</p>', 40, 160);
    cache.set('n2', 'b', '<p>b</p>', 40, 160);
    assertEqual(cache.size(), 2, '2 entries');

    cache.clear();
    assertEqual(cache.size(), 0, 'cleared');
  });

  await test('subtreeNeedsRelayout: 递归检测', () => {
    const root = createMindNode({
      id: 'root',
      type: 'md-seed',
      text: 'Root',
      renderedHeight: 40, // matches estimate
      children: [
        createMindNode({
          id: 'c1',
          type: 'free',
          text: 'Short',
          renderedHeight: 120, // way off from estimate (~40)
          parentId: 'root',
          children: [],
        }),
      ],
    });

    assert(subtreeNeedsRelayout(root), 'subtree needs relayout (c1 changed)');
  });
}

async function main() {
  console.log('══ MindFlow Basic Tests ══');
  await testMDParser();
  await testFrontmatter();
  await testSeedSync();
  await testTreeLayout();
  await testTreeOperations();
  await testInitialExpandLevel();
  await testEventBus();
  await testUndoRedo();
  await testPhase2Layout();

  console.log('\n════════════════════════════');
  console.log(`  Pass: ${pass} | Fail: ${fail}`);
  console.log('════════════════════════════');

  if (fail > 0) {
    process.exit(1);
  }
}

main();
