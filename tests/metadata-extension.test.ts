/**
 * Phase 4 元数据扩展单元测试 — Relation / Flag / Group
 */

import { AnnotationStore } from '../src/db/annotation-store';
import { FileEncoder } from '../src/db/file-encoder';
import { stripExtraFields } from '../src/db/strip-fields';

// ─── Mock DataAdapter ──────────────────────────────────

class MockDataAdapter {
  private files = new Map<string, string>();
  private dirs = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }
  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }
  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    const dir = path.substring(0, path.lastIndexOf('/'));
    if (dir) this.dirs.add(dir);
  }
  async remove(path: string): Promise<void> { this.files.delete(path); }
  async mkdir(path: string): Promise<void> { this.dirs.add(path); }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path + '/';
    const files: string[] = [];
    for (const p of this.files.keys()) {
      if (p.startsWith(prefix)) {
        const rest = p.substring(prefix.length);
        if (!rest.includes('/')) files.push(rest);
      }
    }
    return { files, folders: [] };
  }
}

function createMockVault() {
  return { adapter: new MockDataAdapter() as any, configDir: '.obsidian' };
}

let _c = 0;
function makeAnn(overrides: Record<string, any> = {}): any {
  return {
    uuid: `t-${++_c}`, filePath: 'notes/test.md', type: 'highlight' as const,
    color: 'yellow', text: 'Hello World', note: '', tags: [],
    startOffset: 0, endOffset: 11, startLine: 1,
    contextBefore: '', contextAfter: '', createdAt: Date.now(), updatedAt: Date.now(),
    ...overrides,
  };
}

async function runTests() {
  let passed = 0, failed = 0;
  const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e: any) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
  };

  console.log('\n🧪 Phase 4: Metadata Extension Tests\n');

  // ─── Relation Tests ─────────────────────────────────

  await test('addRelation: creates outgoing relation', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'src1' }));
    await s.addAnnotation(makeAnn({ uuid: 'tgt1' }));
    await s.addRelation('src1', { targetUuid: 'tgt1', type: 'proves', createdAt: Date.now() });
    const ann = s.getAnnotationByUuid('src1');
    if (!ann?.relations || ann.relations.length !== 1) throw new Error('relation not added');
    if (ann.relations[0].targetUuid !== 'tgt1') throw new Error('wrong target');
    if (ann.relations[0].type !== 'proves') throw new Error('wrong type');
  });

  await test('addRelation: creates incoming index', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'src2' }));
    await s.addAnnotation(makeAnn({ uuid: 'tgt2' }));
    await s.addRelation('src2', { targetUuid: 'tgt2', type: 'references', createdAt: Date.now() });
    // v4.2: 双向维护自动在 tgt2 上创建反向关系 tgt2→src2 (isReferencedBy)
    const rels = s.getRelations('tgt2');
    // incoming: src2→tgt2 (references)
    if (rels.incoming.length !== 1) throw new Error(`incoming not indexed, got ${rels.incoming.length}`);
    if (rels.incoming[0].sourceUuid !== 'src2') throw new Error('wrong incoming source');
    // outgoing: tgt2→src2 (isReferencedBy, 自动创建)
    if (rels.outgoing.length !== 1) throw new Error(`reverse relation not created, got ${rels.outgoing.length}`);
    if (rels.outgoing[0].type !== 'isReferencedBy') throw new Error('wrong reverse type');
  });

  await test('addRelation: idempotent (duplicate ignored)', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'src3' }));
    await s.addAnnotation(makeAnn({ uuid: 'tgt3' }));
    await s.addRelation('src3', { targetUuid: 'tgt3', type: 'applies', createdAt: Date.now() });
    await s.addRelation('src3', { targetUuid: 'tgt3', type: 'applies', createdAt: Date.now() });
    const ann = s.getAnnotationByUuid('src3');
    if (!ann?.relations || ann.relations.length !== 1) throw new Error('should be idempotent');
  });

  await test('removeRelation: removes outgoing and incoming', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'src4' }));
    await s.addAnnotation(makeAnn({ uuid: 'tgt4' }));
    await s.addRelation('src4', { targetUuid: 'tgt4', type: 'contrasts', createdAt: Date.now() });
    // v4.2: 双向维护 → tgt4 自动获得反向关系 tgt4→src4 (contrasts, 对称)
    await s.removeRelation('src4', 'tgt4', 'contrasts');
    const ann = s.getAnnotationByUuid('src4');
    if (ann?.relations && ann.relations.length > 0) throw new Error('relation not removed');
    // v4.2: 删除正向关系时，反向关系也被删除
    const tgtAnn = s.getAnnotationByUuid('tgt4');
    if (tgtAnn?.relations && tgtAnn.relations.length > 0) throw new Error('reverse relation not removed');
    const rels = s.getRelations('tgt4');
    if (rels.incoming.length !== 0) throw new Error('incoming not removed');
  });

  await test('getRelations: returns both outgoing and incoming', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'a5' }));
    await s.addAnnotation(makeAnn({ uuid: 'b5' }));
    await s.addAnnotation(makeAnn({ uuid: 'c5' }));
    await s.addRelation('a5', { targetUuid: 'b5', type: 'proves', createdAt: Date.now() });
    await s.addRelation('c5', { targetUuid: 'a5', type: 'references', createdAt: Date.now() });
    const rels = s.getRelations('a5');
    // v4.2: 双向维护改变了结构
    // addRelation(a5→b5, proves) → b5 自动创建 b5→a5 (isProvedBy)
    // addRelation(c5→a5, references) → a5 自动创建 a5→c5 (isReferencedBy)
    // 所以 a5 的 outgoing = [a5→b5 (proves), a5→c5 (isReferencedBy)] = 2
    // a5 的 incoming = [c5→a5 (references from _byRelationIn), b5→a5 (isProvedBy from _byRelationIn)] = 2
    if (rels.outgoing.length !== 2) throw new Error(`wrong outgoing count: ${rels.outgoing.length}`);
    if (rels.incoming.length !== 2) throw new Error(`wrong incoming count: ${rels.incoming.length}`);
  });

  await test('queryAnnotations: hasRelations filter', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'qrel1' }));
    await s.addAnnotation(makeAnn({ uuid: 'qrel2' }));
    await s.addRelation('qrel1', { targetUuid: 'qrel2', type: 'references', createdAt: Date.now() });
    // v4.2: 双向维护 → qrel2 自动获得反向关系 qrel2→qrel1 (isReferencedBy)
    // 所以 qrel1 和 qrel2 都有有效关系
    const withRel = s.queryAnnotations({ hasRelations: true });
    const withoutRel = s.queryAnnotations({ hasRelations: false });
    if (withRel.length !== 2) throw new Error(`hasRelations=true wrong, expected 2 got ${withRel.length}`);
    if (withoutRel.length !== 0) throw new Error(`hasRelations=false wrong, expected 0 got ${withoutRel.length}`);
  });

  // ─── Flag Tests ───────────────────────────────────────

  await test('updateFlags: sets mastery', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'f1' }));
    await s.updateFlags('f1', { mastery: 'learning' });
    const ann = s.getAnnotationByUuid('f1');
    if (ann?.flags?.mastery !== 'learning') throw new Error('mastery not set');
  });

  await test('updateFlags: merges partial updates', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'f2' }));
    await s.updateFlags('f2', { mastery: 'familiar', confidence: 4 });
    await s.updateFlags('f2', { reviewPriority: 'high' });
    const ann = s.getAnnotationByUuid('f2');
    if (ann?.flags?.mastery !== 'familiar') throw new Error('mastery lost after merge');
    if (ann?.flags?.confidence !== 4) throw new Error('confidence lost after merge');
    if (ann?.flags?.reviewPriority !== 'high') throw new Error('reviewPriority not set');
  });

  await test('queryAnnotations: mastery filter', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'fm1' }));
    await s.addAnnotation(makeAnn({ uuid: 'fm2' }));
    await s.updateFlags('fm1', { mastery: 'mastered' });
    const mastered = s.queryAnnotations({ mastery: 'mastered' });
    if (mastered.length !== 1 || mastered[0].uuid !== 'fm1') throw new Error('mastery filter wrong');
  });

  await test('queryAnnotations: reviewPriority filter', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'fp1' }));
    await s.addAnnotation(makeAnn({ uuid: 'fp2' }));
    await s.updateFlags('fp1', { reviewPriority: 'urgent' });
    const urgent = s.queryAnnotations({ reviewPriority: 'urgent' });
    if (urgent.length !== 1 || urgent[0].uuid !== 'fp1') throw new Error('priority filter wrong');
  });

  await test('queryAnnotations: needsCorrection filter', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'fc1' }));
    await s.addAnnotation(makeAnn({ uuid: 'fc2' }));
    await s.updateFlags('fc1', { needsCorrection: true });
    const corrected = s.queryAnnotations({ needsCorrection: true });
    if (corrected.length !== 1 || corrected[0].uuid !== 'fc1') throw new Error('needsCorrection filter wrong');
  });

  // ─── Group Tests ──────────────────────────────────────

  await test('addGroupToAnnotation: adds group', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'g1' }));
    await s.addGroupToAnnotation('g1', 'ch12');
    const ann = s.getAnnotationByUuid('g1');
    if (!ann?.groups || ann.groups.length !== 1 || ann.groups[0] !== 'ch12') throw new Error('group not added');
  });

  await test('addGroupToAnnotation: multiple groups', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'g2' }));
    await s.addGroupToAnnotation('g2', 'ch12');
    await s.addGroupToAnnotation('g2', 'exam');
    const ann = s.getAnnotationByUuid('g2');
    if (ann?.groups?.length !== 2) throw new Error('wrong group count');
  });

  await test('addGroupToAnnotation: idempotent', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'g3' }));
    await s.addGroupToAnnotation('g3', 'ch12');
    await s.addGroupToAnnotation('g3', 'ch12');
    const ann = s.getAnnotationByUuid('g3');
    if (ann?.groups?.length !== 1) throw new Error('should be idempotent');
  });

  await test('removeGroupFromAnnotation: removes group', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'g4' }));
    await s.addGroupToAnnotation('g4', 'ch12');
    await s.addGroupToAnnotation('g4', 'exam');
    await s.removeGroupFromAnnotation('g4', 'ch12');
    const ann = s.getAnnotationByUuid('g4');
    if (ann?.groups?.length !== 1 || ann.groups[0] !== 'exam') throw new Error('group not removed');
  });

  await test('queryAnnotations: group filter', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'qg1' }));
    await s.addAnnotation(makeAnn({ uuid: 'qg2' }));
    await s.addGroupToAnnotation('qg1', 'key_theorems');
    const filtered = s.queryAnnotations({ group: 'key_theorems' });
    if (filtered.length !== 1 || filtered[0].uuid !== 'qg1') throw new Error('group filter wrong');
  });

  await test('getGroupNames: returns all groups', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'gn1' }));
    await s.addGroupToAnnotation('gn1', 'beta');
    await s.addGroupToAnnotation('gn1', 'alpha');
    const groups = s.getGroupNames();
    if (groups.length !== 2 || groups[0] !== 'alpha') throw new Error('groups not sorted');
  });

  // ─── Persistence Tests ────────────────────────────────

  await test('relation persists after flushAll + reinitialize', async () => {
    const v = createMockVault();
    const s1 = new AnnotationStore(); s1.init(v as any); await s1.initialize();
    await s1.addAnnotation(makeAnn({ uuid: 'p1', filePath: 'notes/p.md' }));
    await s1.addAnnotation(makeAnn({ uuid: 'p2', filePath: 'notes/p.md' }));
    await s1.addRelation('p1', { targetUuid: 'p2', type: 'proves', createdAt: Date.now() });
    await s1.updateFlags('p1', { mastery: 'familiar', confidence: 3 });
    await s1.addGroupToAnnotation('p1', 'ch5');
    await s1.flushAll();

    const s2 = new AnnotationStore(); s2.init(v as any); await s2.initialize();
    const ann = s2.getAnnotationByUuid('p1');
    if (!ann?.relations || ann.relations.length !== 1) throw new Error('relation not persisted');
    if (ann.relations[0].type !== 'proves') throw new Error('relation type not persisted');
    if (ann.flags?.mastery !== 'familiar') throw new Error('mastery not persisted');
    if (ann.flags?.confidence !== 3) throw new Error('confidence not persisted');
    if (!ann.groups || ann.groups[0] !== 'ch5') throw new Error('group not persisted');
  });

  await test('stats include v4.0 fields', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'st1' }));
    await s.addAnnotation(makeAnn({ uuid: 'st2' }));
    await s.addRelation('st1', { targetUuid: 'st2', type: 'references', createdAt: Date.now() });
    await s.updateFlags('st1', { mastery: 'learning' });
    await s.addGroupToAnnotation('st1', 'test_group');
    const stats = s.getAnnotationStats();
    // v4.2: 双向维护 → st2 自动获得反向关系，所以 withRelations = 2
    if (stats.withRelations !== 2) throw new Error(`withRelations should be 2, got ${stats.withRelations}`);
    if (stats.withFlags !== 1) throw new Error(`withFlags should be 1, got ${stats.withFlags}`);
    if (stats.withGroups !== 1) throw new Error(`withGroups should be 1, got ${stats.withGroups}`);
    if (stats.byMastery['learning'] !== 1) throw new Error('byMastery wrong');
  });

  await test('P0 review: stats withRelations excludes invalidated-only annotations', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'sr1' }));
    await s.addAnnotation(makeAnn({ uuid: 'sr2' }));
    await s.addAnnotation(makeAnn({ uuid: 'sr3' }));
    // sr1→sr2 (references) — both valid
    await s.addRelation('sr1', { targetUuid: 'sr2', type: 'references', createdAt: Date.now() });
    let stats = s.getAnnotationStats();
    // sr1 + sr2 (自动反向) = 2 with valid relations
    if (stats.withRelations !== 2) throw new Error(`valid only: should be 2, got ${stats.withRelations}`);
    // Invalidate both → 0 with valid relations
    await s.invalidateRelation('sr1', 'sr2', 'references');
    stats = s.getAnnotationStats();
    if (stats.withRelations !== 0) throw new Error(`all invalidated: should be 0, got ${stats.withRelations}`);
    // sr3→sr1 (new valid) → sr1 gets valid incoming (supplements), sr3 gets valid outgoing
    await s.addRelation('sr3', { targetUuid: 'sr1', type: 'supplements', createdAt: Date.now() });
    stats = s.getAnnotationStats();
    // sr1 (reverse from sr3 is valid, relation to sr2 still invalidated) + sr3 (outgoing is valid)
    // = 2 with valid relations (sr2 still has no valid relations)
    if (stats.withRelations !== 2) throw new Error(`partial recovery: should be 2, got ${stats.withRelations}`);
  });

  await test('index consistency after delete with relations', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'd1', filePath: 'notes/del.md' }));
    await s.addAnnotation(makeAnn({ uuid: 'd2', filePath: 'notes/del.md' }));
    await s.addRelation('d1', { targetUuid: 'd2', type: 'proves', createdAt: Date.now() });
    // 删除源标注
    await s.deleteAnnotation('d1');
    // 入边索引应该也被清理
    const rels = s.getRelations('d2');
    if (rels.incoming.length !== 0) throw new Error('incoming should be cleaned after source deletion');
  });

  // ═══════════════════════════════════════════════════════
  // v4.1: P0 元数据架构升级测试
  // ═══════════════════════════════════════════════════════

  // ─── schemaVersion 测试 ─────────────────────────────

  await test('schemaVersion: defaults to 1 for annotations without it', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'sv1' }));  // 没有 schemaVersion
    const ann = s.getAnnotationByUuid('sv1');
    if (ann?.schemaVersion !== 1) throw new Error(`schemaVersion should default to 1, got ${ann?.schemaVersion}`);
  });

  await test('schemaVersion: preserves explicit value 2', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'sv2', schemaVersion: 2 }));
    const ann = s.getAnnotationByUuid('sv2');
    if (ann?.schemaVersion !== 2) throw new Error(`schemaVersion should be 2, got ${ann?.schemaVersion}`);
  });

  await test('schemaVersion: survives persistence round-trip', async () => {
    const v = createMockVault();
    const s = new AnnotationStore(); s.init(v as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'sv3', schemaVersion: 2 }));
    await s.flushAll();
    const s2 = new AnnotationStore(); s2.init(v as any); await s2.initialize();
    const ann = s2.getAnnotationByUuid('sv3');
    if (ann?.schemaVersion !== 2) throw new Error(`schemaVersion not persisted, got ${ann?.schemaVersion}`);
  });

  // ─── Motivation 测试 ────────────────────────────────

  await test('motivation: add and retrieve', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'mot1', motivation: 'questioning' }));
    const ann = s.getAnnotationByUuid('mot1');
    if (ann?.motivation !== 'questioning') throw new Error(`motivation should be questioning, got ${ann?.motivation}`);
  });

  await test('motivation: included in stats byMotivation', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'ms1', motivation: 'highlighting' }));
    await s.addAnnotation(makeAnn({ uuid: 'ms2', motivation: 'commenting' }));
    await s.addAnnotation(makeAnn({ uuid: 'ms3', motivation: 'highlighting' }));
    await s.addAnnotation(makeAnn({ uuid: 'ms4' }));  // no motivation
    const stats = s.getAnnotationStats();
    if (stats.byMotivation['highlighting'] !== 2) throw new Error(`byMotivation.highlighting should be 2, got ${stats.byMotivation['highlighting']}`);
    if (stats.byMotivation['commenting'] !== 1) throw new Error(`byMotivation.commenting should be 1, got ${stats.byMotivation['commenting']}`);
  });

  await test('motivation: filter by motivation', async () => {
    const { applyUnifiedFilter } = await import('../src/search/filter-engine');
    const annotations = [
      makeAnn({ uuid: 'mf1', motivation: 'questioning' }),
      makeAnn({ uuid: 'mf2', motivation: 'highlighting' }),
      makeAnn({ uuid: 'mf3', motivation: 'questioning' }),
      makeAnn({ uuid: 'mf4' }),
    ];
    const results = applyUnifiedFilter(annotations, { motivation: 'questioning' } as any);
    if (results.length !== 2) throw new Error(`should find 2 questioning, got ${results.length}`);
  });

  await test('motivation: motivation=all returns all', async () => {
    const { applyUnifiedFilter } = await import('../src/search/filter-engine');
    const annotations = [
      makeAnn({ uuid: 'ma1', motivation: 'highlighting' }),
      makeAnn({ uuid: 'ma2' }),
    ];
    const results = applyUnifiedFilter(annotations, { motivation: 'all' } as any);
    if (results.length !== 2) throw new Error(`motivation=all should return all, got ${results.length}`);
  });

  await test('motivation: survives persistence', async () => {
    const v = createMockVault();
    const s = new AnnotationStore(); s.init(v as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'mp1', motivation: 'editing' }));
    await s.flushAll();
    const s2 = new AnnotationStore(); s2.init(v as any); await s2.initialize();
    const ann = s2.getAnnotationByUuid('mp1');
    if (ann?.motivation !== 'editing') throw new Error(`motivation not persisted, got ${ann?.motivation}`);
  });

  // ─── u: 命名空间测试 ───────────────────────────────

  await test('u: namespace: normalizeUserFieldKey adds prefix', async () => {
    const { normalizeUserFieldKey } = await import('../src/types/annotation');
    if (normalizeUserFieldKey('difficulty') !== 'u:difficulty') throw new Error('should add u: prefix');
    if (normalizeUserFieldKey('u:source') !== 'u:source') throw new Error('should keep existing u: prefix');
    if (normalizeUserFieldKey('_system') !== '_system') throw new Error('should not prefix system fields');
  });

  await test('u: namespace: stripUserFieldPrefix removes prefix', async () => {
    const { stripUserFieldPrefix } = await import('../src/types/annotation');
    if (stripUserFieldPrefix('u:difficulty') !== 'difficulty') throw new Error('should strip u: prefix');
    if (stripUserFieldPrefix('difficulty') !== 'difficulty') throw new Error('should return as-is if no prefix');
  });

  await test('u: namespace: field filter matches with and without prefix', async () => {
    const { applyUnifiedFilter } = await import('../src/search/filter-engine');
    const annotations = [
      makeAnn({ uuid: 'uf1', fields: { 'u:source': '教材' } }),   // 带 u: 前缀
      makeAnn({ uuid: 'uf2', fields: { source: '论文' } }),        // 不带前缀（旧数据兼容）
      makeAnn({ uuid: 'uf3', fields: { 'u:source': '博客' } }),
    ];
    // 用裸键过滤 → 应该同时匹配 "u:source" 和 "source"
    const results = applyUnifiedFilter(annotations, { fieldFilters: { source: '教材' } } as any);
    if (results.length !== 1 || results[0].uuid !== 'uf1') throw new Error(`should match u:source field with bare key, got ${results.length} results`);
  });

  // ═══════════════════════════════════════════════════════
  // v4.2: Relation 时态 + 双向维护 + 新 Motivation 测试
  // ═══════════════════════════════════════════════════════

  await test('v4.2: addRelation creates reverse relation automatically', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'rsrc' }));
    await s.addAnnotation(makeAnn({ uuid: 'rtgt' }));
    await s.addRelation('rsrc', { targetUuid: 'rtgt', type: 'applies', createdAt: Date.now(), source: 'manual' });
    // 正向: rsrc→rtgt (applies)
    const src = s.getAnnotationByUuid('rsrc');
    if (!src?.relations || src.relations.length !== 1) throw new Error('forward relation not created');
    if (src.relations[0].type !== 'applies') throw new Error('wrong forward type');
    // 反向: rtgt→rsrc (isAppliedBy) — 自动创建
    const tgt = s.getAnnotationByUuid('rtgt');
    if (!tgt?.relations || tgt.relations.length !== 1) throw new Error('reverse relation not created');
    if (tgt.relations[0].type !== 'isAppliedBy') throw new Error('wrong reverse type');
    if (tgt.relations[0].targetUuid !== 'rsrc') throw new Error('wrong reverse target');
    if (tgt.relations[0].source !== 'inferred') throw new Error('reverse should be inferred');
  });

  await test('v4.2: symmetric relations (contrasts/supplements) auto-create reverse', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'sym1' }));
    await s.addAnnotation(makeAnn({ uuid: 'sym2' }));
    await s.addRelation('sym1', { targetUuid: 'sym2', type: 'contrasts', createdAt: Date.now() });
    // 对称关系：sym2 自动获得 sym2→sym1 (contrasts)
    const tgt = s.getAnnotationByUuid('sym2');
    if (!tgt?.relations || tgt.relations.length !== 1) throw new Error('symmetric reverse not created');
    if (tgt.relations[0].type !== 'contrasts') throw new Error('symmetric reverse should be same type');
  });

  await test('v4.2: invalidateRelation soft-deletes and cascades to reverse', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'inv1' }));
    await s.addAnnotation(makeAnn({ uuid: 'inv2' }));
    await s.addRelation('inv1', { targetUuid: 'inv2', type: 'proves', createdAt: Date.now() });
    // 失效正向关系
    await s.invalidateRelation('inv1', 'inv2', 'proves');
    const src = s.getAnnotationByUuid('inv1');
    if (!src?.relations?.[0]?.invalidAt) throw new Error('forward not invalidated');
    // 反向关系也应失效
    const tgt = s.getAnnotationByUuid('inv2');
    const reverseRel = tgt?.relations?.find(r => r.type === 'isProvedBy');
    if (!reverseRel?.invalidAt) throw new Error('reverse not invalidated');
  });

  await test('v4.2: getRelations filters out invalidated by default', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'gf1' }));
    await s.addAnnotation(makeAnn({ uuid: 'gf2' }));
    await s.addRelation('gf1', { targetUuid: 'gf2', type: 'references', createdAt: Date.now() });
    await s.invalidateRelation('gf1', 'gf2', 'references');
    // 默认过滤已失效关系
    const rels = s.getRelations('gf1');
    if (rels.outgoing.length !== 0) throw new Error('invalidated should be filtered');
    // 包含已失效关系
    const relsAll = s.getRelations('gf1', { includeInvalidated: true });
    if (relsAll.outgoing.length !== 1) throw new Error('should include invalidated');
  });

  await test('v4.2: replying and classifying motivation types work', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'mrep', motivation: 'replying' }));
    await s.addAnnotation(makeAnn({ uuid: 'mcls', motivation: 'classifying' }));
    const rep = s.getAnnotationByUuid('mrep');
    const cls = s.getAnnotationByUuid('mcls');
    if (rep?.motivation !== 'replying') throw new Error('replying not stored');
    if (cls?.motivation !== 'classifying') throw new Error('classifying not stored');
    const stats = s.getAnnotationStats();
    if (stats.byMotivation['replying'] !== 1) throw new Error('replying stats wrong');
    if (stats.byMotivation['classifying'] !== 1) throw new Error('classifying stats wrong');
  });

  await test('v4.2: inferMotivation returns classifying for fields-only annotations', async () => {
    const { inferMotivation } = await import('../src/types/annotation');
    const result = inferMotivation({ kind: 'inline', fields: { category: '定义' } });
    if (result !== 'classifying') throw new Error(`expected classifying, got ${result}`);
  });

  await test('v4.2: relation source field persists', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'so1' }));
    await s.addAnnotation(makeAnn({ uuid: 'so2' }));
    await s.addRelation('so1', { targetUuid: 'so2', type: 'references', createdAt: Date.now(), source: 'template' });
    const ann = s.getAnnotationByUuid('so1');
    if (ann?.relations?.[0]?.source !== 'template') throw new Error('source not persisted');
    // 反向关系的 source 应该是 'inferred'
    const tgt = s.getAnnotationByUuid('so2');
    if (tgt?.relations?.[0]?.source !== 'inferred') throw new Error('reverse source should be inferred');
  });

  // ═══════════════════════════════════════════════════════
  // P1: 双向维护补全 + 去重增强
  // ═══════════════════════════════════════════════════════

  await test('P1: restoreRelation cascades to reverse', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'rr1' }));
    await s.addAnnotation(makeAnn({ uuid: 'rr2' }));
    await s.addRelation('rr1', { targetUuid: 'rr2', type: 'applies', createdAt: Date.now() });
    // 双向关系已创建
    const tgtBefore = s.getAnnotationByUuid('rr2');
    if (!tgtBefore?.relations?.[0]?.type) throw new Error('reverse not created');
    // 失效
    await s.invalidateRelation('rr1', 'rr2', 'applies');
    // 正向已失效
    let srcAfter = s.getAnnotationByUuid('rr1');
    if (!srcAfter?.relations?.[0]?.invalidAt) throw new Error('forward not invalidated');
    // 反向也应失效
    let tgtAfter = s.getAnnotationByUuid('rr2');
    if (!tgtAfter?.relations?.find(r => r.type === 'isAppliedBy')?.invalidAt) throw new Error('reverse not invalidated');
    // 恢复正向 → 反向也应恢复
    await s.restoreRelation('rr1', 'rr2', 'applies');
    srcAfter = s.getAnnotationByUuid('rr1');
    if (srcAfter?.relations?.[0]?.invalidAt) throw new Error('forward not restored');
    tgtAfter = s.getAnnotationByUuid('rr2');
    if (tgtAfter?.relations?.find(r => r.type === 'isAppliedBy')?.invalidAt) throw new Error('reverse not restored');
  });

  await test('P1: addRelation reuses invalidated entry instead of creating new', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'ru1' }));
    await s.addAnnotation(makeAnn({ uuid: 'ru2' }));
    // 创建 → 失效 → 重新创建
    await s.addRelation('ru1', { targetUuid: 'ru2', type: 'references', createdAt: Date.now(), source: 'manual' });
    await s.invalidateRelation('ru1', 'ru2', 'references');
    await s.addRelation('ru1', { targetUuid: 'ru2', type: 'references', createdAt: Date.now(), source: 'template' });
    const ann = s.getAnnotationByUuid('ru1');
    // 应该只有 1 条 forward relation（复用而非新建）
    const refRels = ann?.relations?.filter(r => r.type === 'references') ?? [];
    if (refRels.length !== 1) throw new Error(`should reuse invalidated entry, got ${refRels.length} entries`);
    if (refRels[0].invalidAt) throw new Error('should be restored');
    // source 应更新为新值
    if (refRels[0].source !== 'template') throw new Error(`source should be updated to template, got ${refRels[0].source}`);
    // 反向也应被恢复（复用）
    const tgt = s.getAnnotationByUuid('ru2');
    const tgtRels = tgt?.relations?.filter(r => r.type === 'isReferencedBy') ?? [];
    if (tgtRels.length !== 1) throw new Error(`reverse should reuse, got ${tgtRels.length}`);
    if (tgtRels[0].invalidAt) throw new Error('reverse should be restored');
  });

  await test('P1: addRelation is idempotent when relation already active', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'id1' }));
    await s.addAnnotation(makeAnn({ uuid: 'id2' }));
    await s.addRelation('id1', { targetUuid: 'id2', type: 'proves', createdAt: Date.now() });
    // 重复添加不应创建重复条目
    await s.addRelation('id1', { targetUuid: 'id2', type: 'proves', createdAt: Date.now() });
    const ann = s.getAnnotationByUuid('id1');
    const provesRels = ann?.relations?.filter(r => r.type === 'proves' && !r.invalidAt) ?? [];
    if (provesRels.length !== 1) throw new Error(`idempotent failed, got ${provesRels.length} active entries`);
    // 反向也应只有 1 条有效
    const tgt = s.getAnnotationByUuid('id2');
    const reverseRels = tgt?.relations?.filter(r => r.type === 'isProvedBy' && !r.invalidAt) ?? [];
    if (reverseRels.length !== 1) throw new Error(`reverse idempotent failed, got ${reverseRels.length}`);
  });

  await test('P1: removeRelation preserves third-party incoming index', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'ri1' }));
    await s.addAnnotation(makeAnn({ uuid: 'ri2' }));
    await s.addAnnotation(makeAnn({ uuid: 'ri3' }));
    // ri1→ri2 (applies) + ri3→ri1 (references: 第三方入边)
    await s.addRelation('ri1', { targetUuid: 'ri2', type: 'applies', createdAt: Date.now() });
    await s.addRelation('ri3', { targetUuid: 'ri1', type: 'references', createdAt: Date.now() });
    // 验证初始状态：ri1 的 incoming 有 2 条（ri2:isAppliedBy 自动反向 + ri3:references 主动入边）
    let ri1Rels = s.getRelations('ri1');
    if (ri1Rels.incoming.length !== 2) throw new Error(`initial incoming should be 2, got ${ri1Rels.incoming.length}`);
    // ri1 的 outgoing: ri1→ri2 (applies) + ri1→ri3 (isReferencedBy, ri3→ri1 的自动反向)
    if (ri1Rels.outgoing.length !== 2) throw new Error(`initial outgoing should be 2, got ${ri1Rels.outgoing.length}`);
    // 删除 ri1→ri2 → 不应破坏 ri3→ri1 的入边索引，也不应破坏 ri1→ri3 的出边
    await s.removeRelation('ri1', 'ri2', 'applies');
    ri1Rels = s.getRelations('ri1');
    // ri1 的 outgoing 应为 1（ri1→ri3 仍存在）
    if (ri1Rels.outgoing.length !== 1) throw new Error(`outgoing should be 1 after removal, got ${ri1Rels.outgoing.length}`);
    if (ri1Rels.outgoing[0].type !== 'isReferencedBy') throw new Error('remaining outgoing should be isReferencedBy');
    // ri1 的 incoming 应为 1（ri3→ri1 仍有效，ri2:isAppliedBy 应被删除）
    if (ri1Rels.incoming.length !== 1) throw new Error(`third-party incoming preserved failed, got ${ri1Rels.incoming.length}`);
    if (ri1Rels.incoming[0].sourceUuid !== 'ri3') throw new Error('wrong incoming source');
    // ri2 的 incoming 应为空（ri1→ri2 的入边已删除）
    const ri2Rels = s.getRelations('ri2');
    if (ri2Rels.incoming.length !== 0) throw new Error(`ri2 incoming should be 0, got ${ri2Rels.incoming.length}`);
    // ri2 的 outgoing 也应为空（反向关系 isAppliedBy 被同步删除）
    if (ri2Rels.outgoing.length !== 0) throw new Error(`ri2 outgoing should be 0, got ${ri2Rels.outgoing.length}`);
  });

  await test('P1: _stripExtraFields preserves endLine, relations.invalidAt, relations.source', async () => {
    const ann = {
      uuid: 'ep1', filePath: 'test.md', type: 'highlight' as const, color: 'yellow' as const,
      text: 'test', note: '', tags: [],
      startOffset: 0, endOffset: 4, startLine: 0,
      contextBefore: '', contextAfter: '',
      createdAt: 0, updatedAt: 0,
      endLine: 5,  // 关键字段
      relations: [
        { targetUuid: 'ep2', type: 'applies' as const, createdAt: 0, source: 'manual' as const },
        { targetUuid: 'ep3', type: 'references' as const, createdAt: 0, invalidAt: 1000 },
      ],
      motivation: 'classifying' as const,
      schemaVersion: 2,
    } as any;
    const clean = stripExtraFields(ann);
    if (clean.endLine !== 5) throw new Error('endLine not preserved');
    if (clean.relations?.length !== 2) throw new Error('relations not preserved');
    if (clean.relations?.[0]?.source !== 'manual') throw new Error('relation.source not preserved');
    if (clean.relations?.[1]?.invalidAt !== 1000) throw new Error('relation.invalidAt not preserved');
    if (clean.motivation !== 'classifying') throw new Error('motivation not preserved');
    if (clean.schemaVersion !== 2) throw new Error('schemaVersion not preserved');
  });

  // ═══════════════════════════════════════════════════════
  // Round 6 P1: deleteAnnotation 级联清理反向关系数据
  // ═══════════════════════════════════════════════════════

  await test('Round6 P1: deleteAnnotation cascades reverse relation from partner', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'cd1' }));
    await s.addAnnotation(makeAnn({ uuid: 'cd2' }));
    // cd1→cd2 (applies) → cd2 自动获得 cd2→cd1 (isAppliedBy)
    await s.addRelation('cd1', { targetUuid: 'cd2', type: 'applies', createdAt: Date.now() });
    // 验证双向关系已建立
    const cd2Before = s.getAnnotationByUuid('cd2');
    if (!cd2Before?.relations || cd2Before.relations.length !== 1) throw new Error('reverse not created');
    if (cd2Before.relations[0].type !== 'isAppliedBy') throw new Error('wrong reverse type');
    // 删除 cd1
    await s.deleteAnnotation('cd1');
    // cd2 的反向关系应被级联清理（不再悬空）
    const cd2After = s.getAnnotationByUuid('cd2');
    if (cd2After?.relations && cd2After.relations.length > 0) {
      throw new Error(`reverse relation should be cleaned after source deletion, got ${cd2After.relations.length} relations`);
    }
    // getRelations 不应返回悬空关系
    const rels = s.getRelations('cd2');
    if (rels.outgoing.length !== 0) throw new Error('outgoing should be empty after cascade delete');
    if (rels.incoming.length !== 0) throw new Error('incoming should be empty after cascade delete');
    // 统计数应正确
    const stats = s.getAnnotationStats();
    if (stats.withRelations !== 0) throw new Error(`withRelations should be 0, got ${stats.withRelations}`);
  });

  await test('Round6 P1: deleteAnnotation cascades multiple relations', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'cm1' }));
    await s.addAnnotation(makeAnn({ uuid: 'cm2' }));
    await s.addAnnotation(makeAnn({ uuid: 'cm3' }));
    // cm1→cm2 (proves) + cm1→cm3 (references)
    await s.addRelation('cm1', { targetUuid: 'cm2', type: 'proves', createdAt: Date.now() });
    await s.addRelation('cm1', { targetUuid: 'cm3', type: 'references', createdAt: Date.now() });
    // 验证 cm2 和 cm3 各有反向关系
    const cm2Before = s.getAnnotationByUuid('cm2');
    const cm3Before = s.getAnnotationByUuid('cm3');
    if (!cm2Before?.relations || cm2Before.relations.length !== 1) throw new Error('cm2 reverse missing');
    if (!cm3Before?.relations || cm3Before.relations.length !== 1) throw new Error('cm3 reverse missing');
    // 删除 cm1
    await s.deleteAnnotation('cm1');
    // cm2 和 cm3 的反向关系都应被清理
    const cm2After = s.getAnnotationByUuid('cm2');
    const cm3After = s.getAnnotationByUuid('cm3');
    if (cm2After?.relations && cm2After.relations.length > 0) throw new Error('cm2 reverse not cleaned');
    if (cm3After?.relations && cm3After.relations.length > 0) throw new Error('cm3 reverse not cleaned');
  });

  await test('Round6 P1: deleteAnnotation cascades symmetric relations', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'cs1' }));
    await s.addAnnotation(makeAnn({ uuid: 'cs2' }));
    // 对称关系：cs1→cs2 (contrasts) → cs2 自动获得 cs2→cs1 (contrasts)
    await s.addRelation('cs1', { targetUuid: 'cs2', type: 'contrasts', createdAt: Date.now() });
    const cs2Before = s.getAnnotationByUuid('cs2');
    if (cs2Before?.relations?.[0]?.type !== 'contrasts') throw new Error('symmetric reverse not created');
    // 删除 cs1
    await s.deleteAnnotation('cs1');
    // cs2 的对称反向也应被清理
    const cs2After = s.getAnnotationByUuid('cs2');
    if (cs2After?.relations && cs2After.relations.length > 0) {
      throw new Error('symmetric reverse should be cleaned');
    }
  });

  await test('Round6 P1: deleteAnnotationsForFile cascades reverse to other files', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'df1', filePath: 'notes/fileA.md' }));
    await s.addAnnotation(makeAnn({ uuid: 'df2', filePath: 'notes/fileA.md' }));
    await s.addAnnotation(makeAnn({ uuid: 'df3', filePath: 'notes/fileB.md' }));
    // fileA → fileB 跨文件关系
    await s.addRelation('df1', { targetUuid: 'df3', type: 'applies', createdAt: Date.now() });
    // df3 应有反向关系 df3→df1 (isAppliedBy)
    const df3Before = s.getAnnotationByUuid('df3');
    if (!df3Before?.relations || df3Before.relations.length !== 1) throw new Error('cross-file reverse missing');
    // 删除 fileA 的所有标注
    const deletedCount = await s.deleteAnnotationsForFile('notes/fileA.md');
    if (deletedCount !== 2) throw new Error(`should delete 2, got ${deletedCount}`);
    // df3（不同文件）的反向关系应被级联清理
    const df3After = s.getAnnotationByUuid('df3');
    if (df3After?.relations && df3After.relations.length > 0) {
      throw new Error('cross-file reverse should be cleaned');
    }
  });

  await test('Round6 P1: deleteAnnotation with invalidated relations still cleans partner', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'di1' }));
    await s.addAnnotation(makeAnn({ uuid: 'di2' }));
    await s.addRelation('di1', { targetUuid: 'di2', type: 'proves', createdAt: Date.now() });
    // 失效正向关系（软删除）
    await s.invalidateRelation('di1', 'di2', 'proves');
    // di2 仍有反向关系（只是也失效了）
    const di2Before = s.getAnnotationByUuid('di2');
    if (!di2Before?.relations || di2Before.relations.length !== 1) throw new Error('reverse should exist');
    if (!di2Before.relations[0].invalidAt) throw new Error('reverse should be invalidated');
    // 删除 di1（物理删除应清理 di2 的失效反向关系）
    await s.deleteAnnotation('di1');
    const di2After = s.getAnnotationByUuid('di2');
    if (di2After?.relations && di2After.relations.length > 0) {
      throw new Error('invalidated reverse should be cleaned on physical delete');
    }
  });

  // ═══════════════════════════════════════════════════════
  // Round 6 P2: updateAnnotation changes.relations 级联防御
  // ═══════════════════════════════════════════════════════

  await test('Round6 P2: updateAnnotation with relations replacement cleans old reverse', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'ur1' }));
    await s.addAnnotation(makeAnn({ uuid: 'ur2' }));
    await s.addAnnotation(makeAnn({ uuid: 'ur3' }));
    // ur1→ur2 (applies) + ur1→ur3 (proves)
    await s.addRelation('ur1', { targetUuid: 'ur2', type: 'applies', createdAt: Date.now() });
    await s.addRelation('ur1', { targetUuid: 'ur3', type: 'proves', createdAt: Date.now() });
    // 验证反向关系
    const ur2Before = s.getAnnotationByUuid('ur2');
    const ur3Before = s.getAnnotationByUuid('ur3');
    if (!ur2Before?.relations || ur2Before.relations.length !== 1) throw new Error('ur2 reverse missing');
    if (!ur3Before?.relations || ur3Before.relations.length !== 1) throw new Error('ur3 reverse missing');
    // 通过 updateAnnotation 替换 relations，只保留 ur1→ur3
    const ur1 = s.getAnnotationByUuid('ur1')!;
    const newRels = ur1.relations!.filter(r => r.targetUuid === 'ur3');
    await s.updateAnnotation('ur1', { relations: newRels });
    // ur2 的反向关系应被级联清理
    const ur2After = s.getAnnotationByUuid('ur2');
    if (ur2After?.relations && ur2After.relations.length > 0) {
      throw new Error('ur2 reverse should be cleaned after relations replacement');
    }
    // ur3 的反向关系应保留
    const ur3After = s.getAnnotationByUuid('ur3');
    if (!ur3After?.relations || ur3After.relations.length !== 1) {
      throw new Error('ur3 reverse should be preserved');
    }
  });

  await test('Round6 P2: updateAnnotation with relations replacement builds new reverse', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'un1' }));
    await s.addAnnotation(makeAnn({ uuid: 'un2' }));
    await s.addAnnotation(makeAnn({ uuid: 'un3' }));
    // un1→un2 (applies)
    await s.addRelation('un1', { targetUuid: 'un2', type: 'applies', createdAt: 1 });
    // 通过 updateAnnotation 替换 relations，改为 un1→un3 (references)
    await s.updateAnnotation('un1', {
      relations: [{ targetUuid: 'un3', type: 'references' as const, createdAt: Date.now() }]
    });
    // un2 的反向关系应被清理
    const un2After = s.getAnnotationByUuid('un2');
    if (un2After?.relations && un2After.relations.length > 0) {
      throw new Error('un2 reverse should be cleaned');
    }
    // un3 应获得反向关系 isReferencedBy
    const un3After = s.getAnnotationByUuid('un3');
    if (!un3After?.relations || un3After.relations.length !== 1) {
      throw new Error('un3 should have new reverse relation');
    }
    if (un3After.relations[0].type !== 'isReferencedBy') {
      throw new Error(`expected isReferencedBy, got ${un3After.relations[0].type}`);
    }
    if (un3After.relations[0].source !== 'inferred') {
      throw new Error('new reverse should be inferred');
    }
  });

  await test('Round6 P2: updateAnnotation with empty relations cleans all reverses', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'ue1' }));
    await s.addAnnotation(makeAnn({ uuid: 'ue2' }));
    await s.addRelation('ue1', { targetUuid: 'ue2', type: 'contrasts', createdAt: Date.now() });
    // 验证反向关系
    const ue2Before = s.getAnnotationByUuid('ue2');
    if (!ue2Before?.relations || ue2Before.relations.length !== 1) throw new Error('reverse missing');
    // 替换 relations 为空数组
    await s.updateAnnotation('ue1', { relations: [] });
    // ue2 的反向关系应被清理
    const ue2After = s.getAnnotationByUuid('ue2');
    if (ue2After?.relations && ue2After.relations.length > 0) {
      throw new Error('ue2 reverse should be cleaned when relations emptied');
    }
  });

  await test('Round6 P2: updateAnnotation without relations change does not cascade', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'un1' }));
    await s.addAnnotation(makeAnn({ uuid: 'un2' }));
    await s.addRelation('un1', { targetUuid: 'un2', type: 'applies', createdAt: Date.now() });
    // 只更新 note（不涉及 relations）
    await s.updateAnnotation('un1', { note: 'updated note' });
    // un2 的反向关系应保持不变
    const un2After = s.getAnnotationByUuid('un2');
    if (!un2After?.relations || un2After.relations.length !== 1) {
      throw new Error('un2 reverse should be untouched when relations not in changes');
    }
  });

  // ═══════════════════════════════════════════════════════
  // v4.3: Schema-First RelationType
  // ═══════════════════════════════════════════════════════

  await test('v4.3: RelationSchema builds correct reverse map from config', async () => {
    const { RelationSchema, DEFAULT_RELATION_TYPE_CONFIGS } = await import('../src/types/annotation');
    const schema = new RelationSchema(DEFAULT_RELATION_TYPE_CONFIGS);
    // 内置类型的反向映射
    if (schema.getReverse('applies') !== 'isAppliedBy') throw new Error('applies → isAppliedBy');
    if (schema.getReverse('isAppliedBy') !== 'applies') throw new Error('isAppliedBy → applies');
    if (schema.getReverse('contrasts') !== 'contrasts') throw new Error('contrasts is symmetric');
    if (schema.getReverse('generalizes') !== 'specializes') throw new Error('generalizes → specializes');
    // 未知类型
    if (schema.getReverse('unknownType') !== undefined) throw new Error('unknown should be undefined');
  });

  await test('v4.3: RelationSchema getLabel returns label or raw type', async () => {
    const { RelationSchema, DEFAULT_RELATION_TYPE_CONFIGS } = await import('../src/types/annotation');
    const schema = new RelationSchema(DEFAULT_RELATION_TYPE_CONFIGS);
    if (schema.getLabel('applies') !== '应用') throw new Error('label should be 应用');
    if (schema.getLabel('unknownType') !== 'unknownType') throw new Error('unknown should return raw type');
  });

  await test('v4.3: RelationSchema getActiveTypes returns only active types', async () => {
    const { RelationSchema, DEFAULT_RELATION_TYPE_CONFIGS } = await import('../src/types/annotation');
    const schema = new RelationSchema(DEFAULT_RELATION_TYPE_CONFIGS);
    const active = schema.getActiveTypes();
    if (active.length !== 16) throw new Error(`expected 16 active types (v5.8: +7 new), got ${active.length}`);
    if (active.includes('isAppliedBy')) throw new Error('passive type should not be in active list');
    if (!active.includes('applies')) throw new Error('applies should be active');
  });

  await test('v4.3: custom relation type with addRelation creates reverse', async () => {
    const { RelationSchema, RelationTypeConfig } = await import('../src/types/annotation');
    const customConfigs: RelationTypeConfig[] = [
      { id: 'inspires', label: '启发', reverseId: 'inspiredBy', isSymmetric: false, isActive: true, color: '#f59e0b' },
      { id: 'inspiredBy', label: '受启发', reverseId: 'inspires', isSymmetric: false, isActive: false },
    ];
    const schema = new RelationSchema(customConfigs);
    const s = new AnnotationStore();
    s.setRelationSchema(schema);
    s.init(createMockVault() as any);
    await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'cr1' }));
    await s.addAnnotation(makeAnn({ uuid: 'cr2' }));
    // 使用自定义关系类型
    await s.addRelation('cr1', { targetUuid: 'cr2', type: 'inspires', createdAt: Date.now() });
    // cr2 应自动获得反向关系 inspiredBy
    const cr2 = s.getAnnotationByUuid('cr2');
    if (!cr2?.relations || cr2.relations.length !== 1) throw new Error('reverse not created');
    if (cr2.relations[0].type !== 'inspiredBy') throw new Error(`expected inspiredBy, got ${cr2.relations[0].type}`);
    if (cr2.relations[0].source !== 'inferred') throw new Error('reverse should be inferred');
    // 索引正确
    const rels = s.getRelations('cr2');
    if (rels.outgoing.length !== 1) throw new Error('cr2 should have 1 outgoing');
    if (rels.incoming.length !== 1) throw new Error('cr2 should have 1 incoming');
  });

  await test('v4.3: custom symmetric relation type', async () => {
    const { RelationSchema, RelationTypeConfig } = await import('../src/types/annotation');
    const customConfigs: RelationTypeConfig[] = [
      { id: 'relatedTo', label: '相关', reverseId: 'relatedTo', isSymmetric: true, isActive: true, color: '#10b981' },
    ];
    const schema = new RelationSchema(customConfigs);
    const s = new AnnotationStore();
    s.setRelationSchema(schema);
    s.init(createMockVault() as any);
    await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'cs1' }));
    await s.addAnnotation(makeAnn({ uuid: 'cs2' }));
    await s.addRelation('cs1', { targetUuid: 'cs2', type: 'relatedTo', createdAt: Date.now() });
    // 对称关系：cs2 的反向关系类型应与正向相同
    const cs2 = s.getAnnotationByUuid('cs2');
    if (!cs2?.relations || cs2.relations.length !== 1) throw new Error('symmetric reverse not created');
    if (cs2.relations[0].type !== 'relatedTo') throw new Error('symmetric reverse should be same type');
  });

  await test('v4.3: custom relation type deleteAnnotation cascades', async () => {
    const { RelationSchema, RelationTypeConfig } = await import('../src/types/annotation');
    const customConfigs: RelationTypeConfig[] = [
      { id: 'supports', label: '支撑', reverseId: 'supportedBy', isSymmetric: false, isActive: true },
      { id: 'supportedBy', label: '被支撑', reverseId: 'supports', isSymmetric: false, isActive: false },
    ];
    const schema = new RelationSchema(customConfigs);
    const s = new AnnotationStore();
    s.setRelationSchema(schema);
    s.init(createMockVault() as any);
    await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'cd1' }));
    await s.addAnnotation(makeAnn({ uuid: 'cd2' }));
    await s.addRelation('cd1', { targetUuid: 'cd2', type: 'supports', createdAt: Date.now() });
    // 删除 cd1
    await s.deleteAnnotation('cd1');
    // cd2 的反向关系应被级联清理
    const cd2 = s.getAnnotationByUuid('cd2');
    if (cd2?.relations && cd2.relations.length > 0) {
      throw new Error('cd2 reverse should be cleaned after custom type cascade delete');
    }
  });

  await test('v4.3: built-in types still work with default schema', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'bi1' }));
    await s.addAnnotation(makeAnn({ uuid: 'bi2' }));
    // 使用内置关系类型
    await s.addRelation('bi1', { targetUuid: 'bi2', type: 'proves', createdAt: Date.now() });
    const bi2 = s.getAnnotationByUuid('bi2');
    if (!bi2?.relations || bi2.relations.length !== 1) throw new Error('reverse not created');
    if (bi2.relations[0].type !== 'isProvedBy') throw new Error(`expected isProvedBy, got ${bi2.relations[0].type}`);
  });

  // ═══════════════════════════════════════════════════════
  // Phase 1 审计修复测试（P1/P2: 索引一致性）
  // ═══════════════════════════════════════════════════════

  await test('P1 audit: _cascadeUpdateRelations syncs _byRelationOut index', async () => {
    // A→B (applies), B→A (isAppliedBy) auto-created
    // updateAnnotation(A, { relations: [A→C (references)] })
    // After: B's _byRelationOut should NOT have "A:isAppliedBy"
    //         C's _byRelationOut SHOULD have "A:isReferencedBy"
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'p1a' }));
    await s.addAnnotation(makeAnn({ uuid: 'p1b' }));
    await s.addAnnotation(makeAnn({ uuid: 'p1c' }));
    await s.addRelation('p1a', { targetUuid: 'p1b', type: 'applies', createdAt: Date.now() });
    // Verify initial state: B has reverse isAppliedBy
    const relsB = s.getRelations('p1b');
    if (relsB.outgoing.length !== 1) throw new Error('B should have 1 outgoing (isAppliedBy)');
    // Replace A's relations: A→B (applies) becomes A→C (references)
    await s.updateAnnotation('p1a', {
      relations: [{ targetUuid: 'p1c', type: 'references', createdAt: Date.now() }],
    });
    // Verify: getRelations(B).incoming should NOT include A→B anymore
    const relsB2 = s.getRelations('p1b');
    if (relsB2.incoming.length !== 0) throw new Error(`B incoming should be empty, got ${relsB2.incoming.length}`);
    // Verify: getRelations(C).incoming should include A→C (references)
    const relsC = s.getRelations('p1c');
    if (relsC.incoming.length !== 1) throw new Error(`C incoming should be 1, got ${relsC.incoming.length}`);
    if (relsC.incoming[0].relation.type !== 'references') throw new Error('C incoming should be references');
    // Verify: C has auto-created reverse C→A (isReferencedBy)
    const cAnn = s.getAnnotationByUuid('p1c');
    if (!cAnn?.relations || cAnn.relations.length !== 1) throw new Error('C should have 1 outgoing (isReferencedBy)');
  });

  await test('P1 audit: _cascadeUpdateRelations syncs _byRelationIn index', async () => {
    // After replacement, _byRelationIn[A] should reflect new reverse entries
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'p1d' }));
    await s.addAnnotation(makeAnn({ uuid: 'p1e' }));
    await s.addAnnotation(makeAnn({ uuid: 'p1f' }));
    await s.addRelation('p1d', { targetUuid: 'p1e', type: 'references', createdAt: Date.now() });
    // Replace: D→E (references) becomes D→F (proves)
    await s.updateAnnotation('p1d', {
      relations: [{ targetUuid: 'p1f', type: 'proves', createdAt: Date.now() }],
    });
    // Verify: E's reverse is cleaned
    const eAnn = s.getAnnotationByUuid('p1e');
    if (eAnn?.relations && eAnn.relations.length > 0) throw new Error('E reverse should be cleaned');
    // Verify: F has reverse isProvedBy
    const fAnn = s.getAnnotationByUuid('p1f');
    if (!fAnn?.relations || fAnn.relations.length !== 1) throw new Error('F should have reverse isProvedBy');
    if (fAnn.relations[0].type !== 'isProvedBy') throw new Error('F reverse type should be isProvedBy');
    // Verify: getRelations(A).incoming has new entry from F
    const relsD = s.getRelations('p1d');
    if (relsD.incoming.length !== 1) throw new Error(`D incoming should be 1, got ${relsD.incoming.length}`);
    if (relsD.incoming[0].relation.type !== 'isProvedBy') throw new Error('D incoming should be isProvedBy');
  });

  await test('P1 audit: _cascadeUpdateRelations with multiple replacements', async () => {
    // A→B (applies) + A→C (references) → A→D (proves) + A→E (contrasts)
    // Both old reverses cleaned, both new reverses created
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'p1g' }));
    await s.addAnnotation(makeAnn({ uuid: 'p1h' }));
    await s.addAnnotation(makeAnn({ uuid: 'p1i' }));
    await s.addAnnotation(makeAnn({ uuid: 'p1j' }));
    await s.addAnnotation(makeAnn({ uuid: 'p1k' }));
    await s.addRelation('p1g', { targetUuid: 'p1h', type: 'applies', createdAt: Date.now() });
    await s.addRelation('p1g', { targetUuid: 'p1i', type: 'references', createdAt: Date.now() });
    // Replace with new set
    await s.updateAnnotation('p1g', {
      relations: [
        { targetUuid: 'p1j', type: 'proves', createdAt: Date.now() },
        { targetUuid: 'p1k', type: 'contrasts', createdAt: Date.now() },
      ],
    });
    // Old partners should be cleaned
    const hAnn = s.getAnnotationByUuid('p1h');
    const iAnn = s.getAnnotationByUuid('p1i');
    if (hAnn?.relations && hAnn.relations.length > 0) throw new Error('H reverse should be cleaned');
    if (iAnn?.relations && iAnn.relations.length > 0) throw new Error('I reverse should be cleaned');
    // New partners should have reverses
    const jAnn = s.getAnnotationByUuid('p1j');
    const kAnn = s.getAnnotationByUuid('p1k');
    if (!jAnn?.relations || jAnn.relations.length !== 1) throw new Error('J should have reverse');
    if (jAnn.relations[0].type !== 'isProvedBy') throw new Error('J reverse should be isProvedBy');
    if (!kAnn?.relations || kAnn.relations.length !== 1) throw new Error('K should have reverse');
    if (kAnn.relations[0].type !== 'contrasts') throw new Error('K reverse should be contrasts (symmetric)');
    // getRelations checks
    const relsG = s.getRelations('p1g');
    if (relsG.outgoing.length !== 2) throw new Error(`G should have 2 outgoing, got ${relsG.outgoing.length}`);
    if (relsG.incoming.length !== 2) throw new Error(`G should have 2 incoming (reverses), got ${relsG.incoming.length}`);
  });

  await test('P2 audit: _cascadeDeleteRelations directly cleans indexes', async () => {
    // Verify that after deleteAnnotation, _byRelationOut and _byRelationIn
    // are correctly cleaned for the partner annotation
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'p2a' }));
    await s.addAnnotation(makeAnn({ uuid: 'p2b' }));
    await s.addAnnotation(makeAnn({ uuid: 'p2c' }));
    // A→B (applies), B→A (isAppliedBy)
    await s.addRelation('p2a', { targetUuid: 'p2b', type: 'applies', createdAt: Date.now() });
    // A→C (references), C→A (isReferencedBy)
    await s.addRelation('p2a', { targetUuid: 'p2c', type: 'references', createdAt: Date.now() });
    // Delete A — both B and C should have reverses cleaned
    await s.deleteAnnotation('p2a');
    // B should have no relations
    const bAnn = s.getAnnotationByUuid('p2b');
    if (bAnn?.relations && bAnn.relations.length > 0) throw new Error('B reverse should be cleaned');
    // C should have no relations
    const cAnn = s.getAnnotationByUuid('p2c');
    if (cAnn?.relations && cAnn.relations.length > 0) throw new Error('C reverse should be cleaned');
    // B and C should have no incoming from A
    const relsB = s.getRelations('p2b');
    const relsC = s.getRelations('p2c');
    if (relsB.incoming.length !== 0) throw new Error(`B should have 0 incoming, got ${relsB.incoming.length}`);
    if (relsC.incoming.length !== 0) throw new Error(`C should have 0 incoming, got ${relsC.incoming.length}`);
    // B and C should have no outgoing (reverse cleaned)
    if (relsB.outgoing.length !== 0) throw new Error(`B should have 0 outgoing, got ${relsB.outgoing.length}`);
    if (relsC.outgoing.length !== 0) throw new Error(`C should have 0 outgoing, got ${relsC.outgoing.length}`);
  });

  await test('P4 audit: markFileDirty marks loaded files', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'p4a', filePath: 'notes/p4test.md' }));
    // markFileDirty should not throw for loaded files
    s.markFileDirty('notes/p4test.md');
    // markFileDirty should not throw for non-loaded files (silently ignored)
    s.markFileDirty('notes/nonexistent.md');
  });

  // ═══════════════════════════════════════════════════════
  // v5.0: "associates" 关联关系 + 批量失效 + 自关系拦截
  // ═══════════════════════════════════════════════════════

  await test('associates: symmetric relation creates bidirectional', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'assoc-a' }));
    await s.addAnnotation(makeAnn({ uuid: 'assoc-b' }));
    await s.addRelation('assoc-a', { targetUuid: 'assoc-b', type: 'associates', createdAt: Date.now() });
    // 正向
    const srcRels = s.getRelations('assoc-a');
    if (!srcRels.outgoing.some(r => r.targetUuid === 'assoc-b' && r.type === 'associates'))
      throw new Error('should have outgoing associates');
    // 反向（对称，reverseId = 'associates'）
    const tgtRels = s.getRelations('assoc-b');
    if (!tgtRels.outgoing.some(r => r.targetUuid === 'assoc-a' && r.type === 'associates'))
      throw new Error('should have reverse associates (symmetric)');
  });

  await test('associates: invalidate + restore round-trip', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'inv-a' }));
    await s.addAnnotation(makeAnn({ uuid: 'inv-b' }));
    await s.addRelation('inv-a', { targetUuid: 'inv-b', type: 'associates', createdAt: Date.now() });
    // 失效
    await s.invalidateRelation('inv-a', 'inv-b', 'associates');
    const relsAfter = s.getRelations('inv-a');
    if (relsAfter.outgoing.length !== 0) throw new Error('should have no active outgoing');
    const relsAll = s.getRelations('inv-a', { includeInvalidated: true });
    if (relsAll.outgoing.length !== 1) throw new Error('should have 1 including invalidated');
    if (!relsAll.outgoing[0].invalidAt) throw new Error('should have invalidAt set');
    // 恢复
    await s.restoreRelation('inv-a', 'inv-b', 'associates');
    const relsRestored = s.getRelations('inv-a');
    if (relsRestored.outgoing.length !== 1) throw new Error('should be restored');
  });

  await test('invalidateRelationsByType: batch invalidation', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'batch-a', filePath: 'notes/batch.md' }));
    await s.addAnnotation(makeAnn({ uuid: 'batch-b', filePath: 'notes/batch.md' }));
    await s.addAnnotation(makeAnn({ uuid: 'batch-c', filePath: 'notes/batch.md' }));
    await s.addRelation('batch-a', { targetUuid: 'batch-b', type: 'associates', createdAt: Date.now() });
    await s.addRelation('batch-b', { targetUuid: 'batch-c', type: 'associates', createdAt: Date.now() });
    // 批量失效
    const count = await s.invalidateRelationsByType('associates');
    // associates 是对称的，a→b 产生 a→b + b→a，b→c 产生 b→c + c→b，共 4 条
    if (count !== 4) throw new Error(`should invalidate 4 relations, got ${count}`);
    // 所有关系都应为失效状态
    const relsA = s.getRelations('batch-a', { includeInvalidated: true });
    const relsB = s.getRelations('batch-b', { includeInvalidated: true });
    if (!relsA.outgoing.every(r => r.invalidAt)) throw new Error('all batch-a relations should be invalidated');
    if (!relsB.outgoing.every(r => r.invalidAt)) throw new Error('all batch-b relations should be invalidated');
  });

  await test('invalidateRelationsByType: also invalidates reverse type', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'rev-a' }));
    await s.addAnnotation(makeAnn({ uuid: 'rev-b' }));
    await s.addRelation('rev-a', { targetUuid: 'rev-b', type: 'proves', createdAt: Date.now() });
    // proves 的反向是 isProvedBy
    const count = await s.invalidateRelationsByType('proves');
    // 应该失效 proves (1) + isProvedBy (1) = 2
    if (count !== 2) throw new Error(`should invalidate 2 relations (proves + isProvedBy), got ${count}`);
  });

  await test('addRelation: self-relation throws error', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'self-a' }));
    let threw = false;
    try {
      await s.addRelation('self-a', { targetUuid: 'self-a', type: 'associates', createdAt: Date.now() });
    } catch (e: any) {
      threw = true;
      if (!e.message.includes('Self-relation')) throw new Error(`wrong error message: ${e.message}`);
    }
    if (!threw) throw new Error('self-relation should throw error');
  });

  await test('addRelation: source upgrade inferred→manual', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'upgrade-a' }));
    await s.addAnnotation(makeAnn({ uuid: 'upgrade-b' }));
    await s.addRelation('upgrade-a', { targetUuid: 'upgrade-b', type: 'associates', createdAt: Date.now(), source: 'inferred' });
    // 再次添加同关系但 source 更高
    await s.addRelation('upgrade-a', { targetUuid: 'upgrade-b', type: 'associates', createdAt: Date.now(), source: 'manual' });
    const ann = s.getAnnotationByUuid('upgrade-a');
    const rel = ann?.relations?.find(r => r.targetUuid === 'upgrade-b');
    if (rel?.source !== 'manual') throw new Error(`source should be upgraded to manual, got ${rel?.source}`);
  });

  await test('associates: W3C serialization round-trip', async () => {
    const { serializeAnnotation, deserializeAnnotation } = await import('../src/export/w3c-serializer');
    const ann = makeAnn({
      uuid: 'w3c-assoc',
      relations: [{
        targetUuid: 'w3c-other',
        type: 'associates',
        createdAt: 1700000000000,
        source: 'manual',
      }],
    });
    const w3c = serializeAnnotation(ann);
    if (!w3c['markvault:relations']) throw new Error('should have relations in W3C');
    if (w3c['markvault:relations'][0].type !== 'associates') throw new Error('type should be associates');
    const roundTripped = deserializeAnnotation(w3c, ann.filePath);
    if (roundTripped.relations?.[0].type !== 'associates') throw new Error('associates should round-trip');
    if (roundTripped.relations?.[0].source !== 'manual') throw new Error('source should round-trip');
  });

  await test('associates: graph includes symmetric edge', async () => {
    const { buildGraphData } = await import('../src/ui/graph/graph-data-builder');
    const { RelationSchema, DEFAULT_RELATION_TYPE_CONFIGS } = await import('../src/types/annotation');
    const schema = new RelationSchema(DEFAULT_RELATION_TYPE_CONFIGS);
    const annotations = [
      makeAnn({ uuid: 'g-assoc-a', relations: [
        { targetUuid: 'g-assoc-b', type: 'associates', createdAt: Date.now() },
      ]}),
      makeAnn({ uuid: 'g-assoc-b', relations: [
        { targetUuid: 'g-assoc-a', type: 'associates', createdAt: Date.now() },
      ]}),
    ];
    const graph = buildGraphData(annotations, schema, { showIsolated: false, relationTypes: [], filePaths: [], annotationKinds: [] });
    const assocLinks = graph.links.filter(l => l.relationType === 'associates');
    if (assocLinks.length < 1) throw new Error('should have at least 1 associates link');
    const assocColor = assocLinks[0].color;
    if (assocColor !== '#78716C') throw new Error(`associates color should be #78716C, got ${assocColor}`);
  });

  console.log(`\n📊 Phase 4 Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => { console.error('Runner failed:', e); process.exit(1); });
