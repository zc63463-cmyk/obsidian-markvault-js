/**
 * Phase 4 元数据扩展单元测试 — Relation / Flag / Group
 */

import { AnnotationStore } from '../src/db/annotation-store';
import { FileEncoder } from '../src/db/file-encoder';

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
    const rels = s.getRelations('tgt2');
    if (rels.incoming.length !== 1) throw new Error('incoming not indexed');
    if (rels.incoming[0].sourceUuid !== 'src2') throw new Error('wrong incoming source');
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
    await s.removeRelation('src4', 'tgt4', 'contrasts');
    const ann = s.getAnnotationByUuid('src4');
    if (ann?.relations && ann.relations.length > 0) throw new Error('relation not removed');
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
    if (rels.outgoing.length !== 1) throw new Error('wrong outgoing count');
    if (rels.incoming.length !== 1) throw new Error('wrong incoming count');
  });

  await test('queryAnnotations: hasRelations filter', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'qrel1' }));
    await s.addAnnotation(makeAnn({ uuid: 'qrel2' }));
    await s.addRelation('qrel1', { targetUuid: 'qrel2', type: 'references', createdAt: Date.now() });
    const withRel = s.queryAnnotations({ hasRelations: true });
    const withoutRel = s.queryAnnotations({ hasRelations: false });
    if (withRel.length !== 1 || withRel[0].uuid !== 'qrel1') throw new Error('hasRelations=true wrong');
    if (withoutRel.length !== 1 || withoutRel[0].uuid !== 'qrel2') throw new Error('hasRelations=false wrong');
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
    if (stats.withRelations !== 1) throw new Error(`withRelations should be 1, got ${stats.withRelations}`);
    if (stats.withFlags !== 1) throw new Error(`withFlags should be 1, got ${stats.withFlags}`);
    if (stats.withGroups !== 1) throw new Error(`withGroups should be 1, got ${stats.withGroups}`);
    if (stats.byMastery['learning'] !== 1) throw new Error('byMastery wrong');
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

  console.log(`\n📊 Phase 4 Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => { console.error('Runner failed:', e); process.exit(1); });
