/**
 * AnnotationStore 单元测试 — TypeScript
 */

import { AnnotationStore } from '../src/db/annotation-store';

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

  console.log('\n🧪 AnnotationStore Unit Tests\n');

  await test('add + get by uuid', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    const a = makeAnn(); await s.addAnnotation(a);
    const f = s.getAnnotationByUuid(a.uuid);
    if (!f) throw new Error('not found'); if (f.uuid !== a.uuid) throw new Error('uuid mismatch');
  });

  await test('add + get by file', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'a1', filePath: 'notes/a.md' }));
    await s.addAnnotation(makeAnn({ uuid: 'a2', filePath: 'notes/a.md' }));
    await s.addAnnotation(makeAnn({ uuid: 'a3', filePath: 'notes/b.md' }));
    if (s.getAnnotationsForFile('notes/a.md').length !== 2) throw new Error('wrong count for a.md');
    if (s.getAnnotationsForFile('notes/b.md').length !== 1) throw new Error('wrong count for b.md');
  });

  await test('update annotation', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'u1', note: 'old' }));
    await s.updateAnnotation('u1', { note: 'new' });
    if (s.getAnnotationByUuid('u1')!.note !== 'new') throw new Error('note not updated');
  });

  await test('delete annotation', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'd1' }));
    if (!s.getAnnotationByUuid('d1')) throw new Error('should exist');
    await s.deleteAnnotation('d1');
    if (s.getAnnotationByUuid('d1')) throw new Error('should be deleted');
  });

  await test('index consistency after add/delete', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'idx1', filePath: 'notes/idx.md' }));
    if (!s.getAnnotationByUuid('idx1')) throw new Error('missing from uuid index');
    if (s.getAnnotationsForFile('notes/idx.md').length !== 1) throw new Error('missing from file index');
    await s.deleteAnnotation('idx1');
    if (s.getAnnotationByUuid('idx1')) throw new Error('still in uuid index');
    if (s.getAnnotationsForFile('notes/idx.md').length !== 0) throw new Error('still in file index');
  });

  await test('_stripExtraFields removes _source/_needsUpgrade', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ _source: 'markdown', _needsUpgrade: true, uuid: 'cl1' }));
    const f = s.getAnnotationByUuid('cl1');
    if (!f) throw new Error('not found');
    if ('_source' in f) throw new Error('_source should be stripped');
    if ('_needsUpgrade' in f) throw new Error('_needsUpgrade should be stripped');
  });

  await test('query by type', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'q1', type: 'highlight' }));
    await s.addAnnotation(makeAnn({ uuid: 'q2', type: 'bold' }));
    if (s.queryAnnotations({ type: 'highlight' }).length !== 1) throw new Error('wrong count');
  });

  await test('query by color', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'c1', color: 'yellow' }));
    await s.addAnnotation(makeAnn({ uuid: 'c2', color: 'green' }));
    await s.addAnnotation(makeAnn({ uuid: 'c3', color: 'yellow' }));
    if (s.queryAnnotations({ color: 'yellow' }).length !== 2) throw new Error('wrong count');
  });

  await test('query with text search', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 's1', text: 'Hello World' }));
    await s.addAnnotation(makeAnn({ uuid: 's2', text: 'Goodbye Moon' }));
    const r = s.queryAnnotations({ searchQuery: 'hello' });
    if (r.length !== 1 || r[0].uuid !== 's1') throw new Error('wrong result');
  });

  await test('flushAll persists data', async () => {
    const s = new AnnotationStore(); const v = createMockVault(); s.init(v as any); await s.initialize();
    await s.addAnnotation(makeAnn({ uuid: 'p1', filePath: 'notes/p.md' }));
    await s.flushAll();
    if (!v.adapter.files.has('.obsidian/plugins/markvault-js/_index.json')) throw new Error('no index');
    if (!v.adapter.files.has('.obsidian/plugins/markvault-js/_meta.json')) throw new Error('no meta');
  });

  await test('lazy load from shard', async () => {
    const v = createMockVault();
    const s1 = new AnnotationStore(); s1.init(v as any); await s1.initialize();
    await s1.addAnnotation(makeAnn({ uuid: 'll1', filePath: 'notes/lazy.md' }));
    await s1.flushAll();

    const s2 = new AnnotationStore(); s2.init(v as any); await s2.initialize();
    if (s2.getAnnotationByUuid('ll1')) throw new Error('should not be loaded yet');
    await s2.ensureFileLoaded('notes/lazy.md');
    if (!s2.getAnnotationByUuid('ll1')) throw new Error('should be loaded from shard');
  });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => { console.error('Runner failed:', e); process.exit(1); });
