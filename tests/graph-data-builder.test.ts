/**
 * Phase 2 关系图谱系统测试
 *
 * 测试 GraphDataBuilder 的核心逻辑：
 * - 节点构建（标注→图节点）
 * - 边构建（关系→图边）
 * - 过滤（关系类型/文件路径/标注类型/孤立节点）
 * - 双向边 curvature 计算
 * - 边去重
 * - 边界情况（空图谱/单节点/自环/孤立节点）
 */

import '../src/db/annotation-store'; // 初始化单例
import { RelationSchema, DEFAULT_RELATION_TYPE_CONFIGS, type Annotation, type RelationTypeConfig } from '../src/types/annotation';
import { buildGraphData, type GraphNode, type GraphLink } from '../src/ui/graph/graph-data-builder';
import type { GraphFilter } from '../src/ui/graph/graph-types';

// ── 测试基础设施 ──────────────────────────

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

// ── Mock 辅助函数 ──────────────────────────

function makeAnn(overrides: Partial<Annotation> & { uuid: string }): Annotation {
  return {
    uuid: overrides.uuid,
    text: overrides.text || `Annotation ${overrides.uuid}`,
    filePath: overrides.filePath || 'test.md',
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 1,
    kind: overrides.kind || 'inline',
    type: overrides.type || 'highlight',
    color: overrides.color,
    note: overrides.note,
    tags: overrides.tags,
    fields: overrides.fields,
    relations: overrides.relations,
    groups: overrides.groups,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
    ...overrides,
  } as Annotation;
}

const defaultSchema = new RelationSchema(DEFAULT_RELATION_TYPE_CONFIGS);
const noFilter: GraphFilter = { relationTypes: [], filePaths: [], annotationKinds: [], showIsolated: false, showInvalidated: true, searchQuery: '', neighborDepth: 0, focalNodeId: null };

// ── 测试开始 ──────────────────────────

async function runTests() {

console.log('\n📊 Phase 2: Graph Data Builder Tests');
console.log('═'.repeat(60));

await test('empty annotations → empty graph', async () => {
  const result = buildGraphData([], defaultSchema, noFilter);
  assertEqual(result.nodes.length, 0, 'nodes');
  assertEqual(result.links.length, 0, 'links');
});

await test('single annotation with no relations → isolated node (filtered out)', async () => {
  const anns = [makeAnn({ uuid: 'a1' })];
  const result = buildGraphData(anns, defaultSchema, noFilter);
  assertEqual(result.nodes.length, 0, 'isolated nodes should be filtered out by default');
  assertEqual(result.links.length, 0, 'no links');
});

await test('single annotation with showIsolated → 1 node', async () => {
  const anns = [makeAnn({ uuid: 'a1', kind: 'block' })];
  const filter: GraphFilter = { ...noFilter, showIsolated: true };
  const result = buildGraphData(anns, defaultSchema, filter);
  assertEqual(result.nodes.length, 1, 'should have 1 node');
  assertEqual(result.nodes[0].id, 'a1', 'node id');
  assertEqual(result.nodes[0].annotationKind, 'block', 'node kind');
  assertEqual(result.links.length, 0, 'no links');
});

await test('two annotations with relation → 2 nodes + 2 links (forward + reverse)', async () => {
  const anns = [
    makeAnn({
      uuid: 'a1',
      relations: [{ targetUuid: 'a2', type: 'applies', createdAt: Date.now(), source: 'user' }],
    }),
    makeAnn({ uuid: 'a2' }),
  ];
  const result = buildGraphData(anns, defaultSchema, noFilter);
  assertEqual(result.nodes.length, 2, 'should have 2 nodes');
  assertEqual(result.links.length, 1, 'should have 1 link (forward only)');
  assertEqual(result.links[0].source, 'a1', 'link source');
  assertEqual(result.links[0].target, 'a2', 'link target');
  assertEqual(result.links[0].relationType, 'applies', 'link type');
});

await test('bidirectional edges get curvature', async () => {
  // a1→a2 (applies) AND a2→a1 (isAppliedBy) — true bidirectional
  const anns = [
    makeAnn({
      uuid: 'a1',
      relations: [
        { targetUuid: 'a2', type: 'applies', createdAt: Date.now(), source: 'user' },
      ],
    }),
    makeAnn({
      uuid: 'a2',
      relations: [
        { targetUuid: 'a1', type: 'isAppliedBy', createdAt: Date.now(), source: 'inferred' },
      ],
    }),
  ];
  const result = buildGraphData(anns, defaultSchema, noFilter);
  // Both edges exist between a1 and a2 → curvature should be non-zero
  const hasCurvature = result.links.some(l => l.curvature > 0);
  assert(hasCurvature, 'bidirectional edges should have curvature > 0');
});

await test('node color from annotation color', async () => {
  const anns = [
    makeAnn({
      uuid: 'a1',
      color: '#ff0000',
      relations: [{ targetUuid: 'a2', type: 'references', createdAt: Date.now(), source: 'user' }],
    }),
    makeAnn({ uuid: 'a2' }),
  ];
  const result = buildGraphData(anns, defaultSchema, noFilter);
  const node = result.nodes.find(n => n.id === 'a1');
  assert(node, 'node a1 should exist');
  assertEqual(node!.color, '#ff0000', 'color should be from annotation');
});

// P1-1: 预设颜色 ID 解析为 hex
await test('preset color ID resolved to hex', async () => {
  const anns = [
    makeAnn({
      uuid: 'a1',
      color: 'yellow',  // preset ID → should resolve to #FACC15
      relations: [{ targetUuid: 'a2', type: 'references', createdAt: Date.now(), source: 'user' }],
    }),
    makeAnn({ uuid: 'a2' }),
  ];
  const result = buildGraphData(anns, defaultSchema, noFilter);
  const node = result.nodes.find(n => n.id === 'a1');
  assert(node, 'node a1 should exist');
  assertEqual(node!.color, '#FACC15', 'preset ID "yellow" should resolve to #FACC15');
});

// P1-2: 目标节点不重复入组
await test('target node not duplicated', async () => {
  const anns = [
    makeAnn({
      uuid: 'a1',
      relations: [{ targetUuid: 'a2', type: 'references', createdAt: Date.now(), source: 'user' }],
    }),
    makeAnn({
      uuid: 'a2',
      relations: [{ targetUuid: 'a1', type: 'references', createdAt: Date.now(), source: 'user' }],
    }),
  ];
  const result = buildGraphData(anns, defaultSchema, noFilter);
  // Should have exactly 2 nodes, not 3 or 4
  assertEqual(result.nodes.length, 2, 'should have exactly 2 unique nodes');
  const a1Count = result.nodes.filter(n => n.id === 'a1').length;
  const a2Count = result.nodes.filter(n => n.id === 'a2').length;
  assertEqual(a1Count, 1, 'a1 should appear exactly once');
  assertEqual(a2Count, 1, 'a2 should appear exactly once');
});

await test('node color from kind when no annotation color', async () => {
  const anns = [
    makeAnn({
      uuid: 'a1',
      kind: 'block',
      relations: [{ targetUuid: 'a2', type: 'references', createdAt: Date.now(), source: 'user' }],
    }),
    makeAnn({ uuid: 'a2' }),
  ];
  const result = buildGraphData(anns, defaultSchema, noFilter);
  const node = result.nodes.find(n => n.id === 'a1');
  assert(node, 'node a1 should exist');
  assertEqual(node!.color, '#3b82f6', 'block color should be blue');
});

await test('filter by relation type', async () => {
  const anns = [
    makeAnn({
      uuid: 'a1',
      relations: [
        { targetUuid: 'a2', type: 'applies', createdAt: Date.now(), source: 'user' },
        { targetUuid: 'a3', type: 'references', createdAt: Date.now(), source: 'user' },
      ],
    }),
    makeAnn({ uuid: 'a2' }),
    makeAnn({ uuid: 'a3' }),
  ];
  const filter: GraphFilter = { ...noFilter, relationTypes: ['applies'] };
  const result = buildGraphData(anns, defaultSchema, filter);
  // Only the 'applies' edge should be included, a3 may still be included as isolated
  const appliesLinks = result.links.filter(l => l.relationType === 'applies');
  const refsLinks = result.links.filter(l => l.relationType === 'references');
  assertEqual(appliesLinks.length, 1, 'should have applies link');
  assertEqual(refsLinks.length, 0, 'should not have references link');
});

await test('filter by file path', async () => {
  const anns = [
    makeAnn({ uuid: 'a1', filePath: 'notes/math.md', relations: [{ targetUuid: 'a2', type: 'references', createdAt: Date.now(), source: 'user' }] }),
    makeAnn({ uuid: 'a2', filePath: 'notes/physics.md' }),
    makeAnn({ uuid: 'a3', filePath: 'notes/chem.md' }),
  ];
  const filter: GraphFilter = { ...noFilter, filePaths: ['notes/math.md'] };
  const result = buildGraphData(anns, defaultSchema, filter);
  // Only a1's file matches, but a2 is a target so it should be included
  const a1Node = result.nodes.find(n => n.id === 'a1');
  const a3Node = result.nodes.find(n => n.id === 'a3');
  assert(a1Node, 'a1 should be in graph (file matches)');
  assert(!a3Node, 'a3 should not be in graph (file does not match)');
});

await test('filter by annotation kind', async () => {
  const anns = [
    makeAnn({ uuid: 'a1', kind: 'block', relations: [{ targetUuid: 'a2', type: 'references', createdAt: Date.now(), source: 'user' }] }),
    makeAnn({ uuid: 'a2', kind: 'inline' }),
    makeAnn({ uuid: 'a3', kind: 'region' }),
  ];
  const filter: GraphFilter = { ...noFilter, annotationKinds: ['block'] };
  const result = buildGraphData(anns, defaultSchema, filter);
  const a1Node = result.nodes.find(n => n.id === 'a1');
  const a3Node = result.nodes.find(n => n.id === 'a3');
  assert(a1Node, 'a1 (block) should be in graph');
  assert(!a3Node, 'a3 (region) should not be in graph');
});

await test('invalidated relations render as dashed', async () => {
  const anns = [
    makeAnn({
      uuid: 'a1',
      relations: [{ targetUuid: 'a2', type: 'applies', createdAt: Date.now(), source: 'user', invalidAt: Date.now() }],
    }),
    makeAnn({ uuid: 'a2' }),
  ];
  const result = buildGraphData(anns, defaultSchema, noFilter);
  assertEqual(result.links.length, 1, 'should have 1 link');
  assert(result.links[0].isInvalidated, 'link should be marked as invalidated');
});

await test('node val increases with degree', async () => {
  const anns = [
    makeAnn({
      uuid: 'hub',
      relations: [
        { targetUuid: 'a', type: 'references', createdAt: Date.now(), source: 'user' },
        { targetUuid: 'b', type: 'references', createdAt: Date.now(), source: 'user' },
        { targetUuid: 'c', type: 'references', createdAt: Date.now(), source: 'user' },
      ],
    }),
    makeAnn({ uuid: 'a' }),
    makeAnn({ uuid: 'b' }),
    makeAnn({ uuid: 'c' }),
  ];
  const result = buildGraphData(anns, defaultSchema, noFilter);
  const hubNode = result.nodes.find(n => n.id === 'hub');
  const aNode = result.nodes.find(n => n.id === 'a');
  assert(hubNode && aNode, 'both nodes should exist');
  assert(hubNode!.val > aNode!.val, 'hub should have larger val than leaf');
});

await test('label truncation for long text', async () => {
  // v5.5: 标签不再在 buildGraphData 中截断，而是存储原始值
  // 截断逻辑移到了 drawNode() 渲染层（根据 globalScale 动态截断）
  // 这里测试：长 alias 应原样保留在 node.label 中
  const longAlias = 'A'.repeat(100);
  const anns = [
    makeAnn({
      uuid: 'a1',
      alias: longAlias,
      relations: [{ targetUuid: 'a2', type: 'references', createdAt: Date.now(), source: 'user' }],
    }),
    makeAnn({ uuid: 'a2' }),
  ];
  const result = buildGraphData(anns, defaultSchema, noFilter);
  const node = result.nodes.find(n => n.id === 'a1');
  assert(node, 'node should exist');
  // v5.5: label 保留原始完整值（截断在渲染层处理）
  assert(node!.label === longAlias, 'label should preserve full alias text');
  assert(node!.labelLength === 100, 'labelLength should reflect original length');
});

await test('custom relation type from schema', async () => {
  const customSchema = new RelationSchema([
    ...DEFAULT_RELATION_TYPE_CONFIGS,
    { id: 'inspires', label: 'Inspires', reverseId: 'inspiredBy', isSymmetric: false, isBuiltIn: false, isActive: true, color: '#e11d48' },
  ]);
  const anns = [
    makeAnn({
      uuid: 'a1',
      relations: [{ targetUuid: 'a2', type: 'inspires', createdAt: Date.now(), source: 'user' }],
    }),
    makeAnn({ uuid: 'a2' }),
  ];
  const result = buildGraphData(anns, customSchema, noFilter);
  assertEqual(result.links.length, 1, 'should have 1 link');
  assertEqual(result.links[0].relationType, 'inspires', 'link type');
  assertEqual(result.links[0].relationLabel, 'Inspires', 'link label from schema');
  assertEqual(result.links[0].color, '#e11d48', 'link color from schema');
});

await test('deduplication: same source→target+type keeps non-invalidated', async () => {
  const anns = [
    makeAnn({
      uuid: 'a1',
      relations: [
        { targetUuid: 'a2', type: 'applies', createdAt: Date.now() - 1000, source: 'user', invalidAt: Date.now() },
        { targetUuid: 'a2', type: 'applies', createdAt: Date.now(), source: 'user' },
      ],
    }),
    makeAnn({ uuid: 'a2' }),
  ];
  const result = buildGraphData(anns, defaultSchema, noFilter);
  // Two edges with same source→target+type → should be deduplicated (non-invalidated wins)
  const appliesLinks = result.links.filter(l => l.relationType === 'applies');
  assertEqual(appliesLinks.length, 1, 'should have 1 applies link after dedup');
  assert(!appliesLinks[0].isInvalidated, 'non-invalidated should win');
});

// ── P2-6: 补漏测试 ──────────────────────────

// T1: curvature — 同向多类型关系应分配不同 curvature（BUG-11 回归验证）
await test('curvature: same-direction multiple types get distinct non-zero curvature', async () => {
  // a1 → a2 with both 'applies' and 'references' (same direction, different types)
  const anns = [
    makeAnn({
      uuid: 'a1',
      relations: [
        { targetUuid: 'a2', type: 'applies', createdAt: Date.now(), source: 'user' },
        { targetUuid: 'a2', type: 'references', createdAt: Date.now(), source: 'user' },
      ],
    }),
    makeAnn({ uuid: 'a2' }),
  ];
  const result = buildGraphData(anns, defaultSchema, noFilter);
  assertEqual(result.links.length, 2, 'should have 2 links (one per type)');
  // Both same-direction edges need curvature > 0 to avoid visual overlap
  const curvatures = result.links.map(l => l.curvature);
  assert(curvatures.every(c => c > 0), 'all same-direction edges should have curvature > 0');
  // Curvatures must be distinct so arcs don't overlap
  assert(curvatures[0] !== curvatures[1], 'same-direction edges should have different curvature values');
});

// T1b: curvature — 双向 + 同向多类型混合场景
await test('curvature: bidirectional with same-direction multi-type in forward direction', async () => {
  // a1 → a2: [applies, references];  a2 → a1: [isAppliedBy]
  // forward edges (a1→a2) should have positive curvature
  // reverse edge (a2→a1) should have negative curvature
  const anns = [
    makeAnn({
      uuid: 'a1',
      relations: [
        { targetUuid: 'a2', type: 'applies', createdAt: Date.now(), source: 'user' },
        { targetUuid: 'a2', type: 'references', createdAt: Date.now(), source: 'user' },
      ],
    }),
    makeAnn({
      uuid: 'a2',
      relations: [
        { targetUuid: 'a1', type: 'isAppliedBy', createdAt: Date.now(), source: 'inferred' },
      ],
    }),
  ];
  const result = buildGraphData(anns, defaultSchema, noFilter);
  assertEqual(result.links.length, 3, 'should have 3 links total');

  const a1toA2 = result.links.filter(l => l.source === 'a1' && l.target === 'a2');
  const a2toA1 = result.links.filter(l => l.source === 'a2' && l.target === 'a1');

  assertEqual(a1toA2.length, 2, 'should have 2 forward links');
  assertEqual(a2toA1.length, 1, 'should have 1 reverse link');

  // Forward edges: positive curvature
  assert(a1toA2.every(l => l.curvature > 0), 'forward edges should have positive curvature');
  assert(a1toA2[0].curvature !== a1toA2[1].curvature, 'forward edges should have distinct curvature');

  // Reverse edge: negative curvature
  assert(a2toA1[0].curvature < 0, 'reverse edge should have negative curvature');
});

// T2: bfsReachable — 邻居深度过滤（通过 buildGraphData 间接测试）
await test('neighbor depth: depth=1 returns focal node + direct neighbors only', async () => {
  // a1 (focal) → a2, a1 → a3;  a2 → a4 (2 hops)
  const anns = [
    makeAnn({
      uuid: 'a1',
      relations: [
        { targetUuid: 'a2', type: 'references', createdAt: Date.now(), source: 'user' },
        { targetUuid: 'a3', type: 'references', createdAt: Date.now(), source: 'user' },
      ],
    }),
    makeAnn({
      uuid: 'a2',
      relations: [{ targetUuid: 'a4', type: 'references', createdAt: Date.now(), source: 'user' }],
    }),
    makeAnn({ uuid: 'a3' }),
    makeAnn({ uuid: 'a4' }),
  ];
  const filter: GraphFilter = { ...noFilter, neighborDepth: 1, focalNodeId: 'a1' };
  const result = buildGraphData(anns, defaultSchema, filter);

  const nodeIds = result.nodes.map(n => n.id);
  assert(nodeIds.includes('a1'), 'a1 (focal) should be present');
  assert(nodeIds.includes('a2'), 'a2 (1 hop via a1→a2) should be present');
  assert(nodeIds.includes('a3'), 'a3 (1 hop via a1→a3) should be present');
  assert(!nodeIds.includes('a4'), 'a4 (2 hops away) should NOT be present');
  assertEqual(result.nodes.length, 3, 'should have exactly 3 nodes');
});

await test('neighbor depth: depth=2 includes second-hop neighbors', async () => {
  // a1 → a2 → a3 → a4  (chain of 4)
  const anns = [
    makeAnn({
      uuid: 'a1',
      relations: [{ targetUuid: 'a2', type: 'references', createdAt: Date.now(), source: 'user' }],
    }),
    makeAnn({
      uuid: 'a2',
      relations: [{ targetUuid: 'a3', type: 'references', createdAt: Date.now(), source: 'user' }],
    }),
    makeAnn({
      uuid: 'a3',
      relations: [{ targetUuid: 'a4', type: 'references', createdAt: Date.now(), source: 'user' }],
    }),
    makeAnn({ uuid: 'a4' }),
  ];
  const filter: GraphFilter = { ...noFilter, neighborDepth: 2, focalNodeId: 'a1' };
  const result = buildGraphData(anns, defaultSchema, filter);

  const nodeIds = result.nodes.map(n => n.id);
  assert(nodeIds.includes('a1'), 'a1 should be present');
  assert(nodeIds.includes('a2'), 'a2 (1 hop) should be present');
  assert(nodeIds.includes('a3'), 'a3 (2 hops) should be present');
  assert(!nodeIds.includes('a4'), 'a4 (3 hops) should NOT be present');
  assertEqual(result.nodes.length, 3, 'should have exactly 3 nodes');
});

await test('neighbor depth: unknown focalNodeId → empty graph', async () => {
  const anns = [
    makeAnn({
      uuid: 'a1',
      relations: [{ targetUuid: 'a2', type: 'references', createdAt: Date.now(), source: 'user' }],
    }),
    makeAnn({ uuid: 'a2' }),
  ];
  const filter: GraphFilter = { ...noFilter, neighborDepth: 1, focalNodeId: 'no-such-node' };
  const result = buildGraphData(anns, defaultSchema, filter);
  assertEqual(result.nodes.length, 0, 'unknown focalNodeId should produce empty graph');
  assertEqual(result.links.length, 0, 'no links when no nodes match');
});

await test('neighbor depth: depth=0 with focalNodeId → no filtering', async () => {
  // depth=0 means no BFS limiting — behaves same as no filter
  const anns = [
    makeAnn({
      uuid: 'a1',
      relations: [{ targetUuid: 'a2', type: 'references', createdAt: Date.now(), source: 'user' }],
    }),
    makeAnn({ uuid: 'a2' }),
  ];
  const filter: GraphFilter = { ...noFilter, neighborDepth: 0, focalNodeId: 'a1' };
  const result = buildGraphData(anns, defaultSchema, filter);
  assertEqual(result.nodes.length, 2, 'depth=0 should not filter any nodes');
  assertEqual(result.links.length, 1, 'all links should remain');
});

// T3: 邻居深度 — 双向边（BFS 视为无向图）
await test('neighbor depth: BFS treats graph as undirected — incoming edges count as reachable', async () => {
  // a1 has NO outgoing relations. a3 → a1 (a3 points to a1).
  // Directed: from a1 you cannot reach anyone (no outgoing edges).
  // Undirected (BFS): from a1 you CAN reach a3 through the reverse edge.
  const anns = [
    makeAnn({ uuid: 'a1' }),  // focal — no outgoing edges
    makeAnn({
      uuid: 'a3',
      relations: [{ targetUuid: 'a1', type: 'references', createdAt: Date.now(), source: 'user' }],
    }),
  ];
  const filter: GraphFilter = { ...noFilter, neighborDepth: 1, focalNodeId: 'a1' };
  const result = buildGraphData(anns, defaultSchema, filter);

  const nodeIds = result.nodes.map(n => n.id);
  assert(nodeIds.includes('a1'), 'focal node a1 should be present');
  assert(nodeIds.includes('a3'), 'a3 should be reachable via undirected BFS (incoming edge counts)');
  assertEqual(result.nodes.length, 2, 'both nodes reachable via undirected traversal');
});

// ── 报告 ──────────────────────────

console.log('\n' + '═'.repeat(60));
console.log(`📊 Phase 2 Graph Results: ${pass} passed, ${fail} failed, ${pass + fail} total`);

if (fail > 0) {
  process.exit(1);
}

} // end runTests

runTests().catch(e => { console.error('Runner failed:', e); process.exit(1); });
