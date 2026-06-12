/**
 * AnnotationStore 单元测试 — 纯 JS (no TypeScript)
 *
 * 测试核心存储引擎的 CRUD、索引一致性、查询过滤、分片读写等功能。
 * 使用 mock DataAdapter 模拟 Obsidian 的 vault.adapter。
 */

// ─── Mock DataAdapter ──────────────────────────────────

class MockDataAdapter {
  constructor() {
    this.files = new Map();
    this.dirs = new Set();
  }

  async exists(path) {
    return this.files.has(path) || this.dirs.has(path);
  }

  async read(path) {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }

  async write(path, content) {
    this.files.set(path, content);
    const dir = path.substring(0, path.lastIndexOf('/'));
    if (dir) this.dirs.add(dir);
  }

  async remove(path) {
    this.files.delete(path);
  }

  async mkdir(path) {
    this.dirs.add(path);
  }

  async list(path) {
    const prefix = path + '/';
    const files = [];
    for (const p of this.files.keys()) {
      if (p.startsWith(prefix)) {
        const rest = p.substring(prefix.length);
        if (!rest.includes('/')) files.push(rest);
      }
    }
    return { files, folders: [] };
  }
}

// ─── Mock Vault ────────────────────────────────────────

function createMockVault() {
  const adapter = new MockDataAdapter();
  return { adapter, configDir: '.obsidian' };
}

// ─── Test Helpers ──────────────────────────────────────

let _counter = 0;
function makeAnnotation(overrides = {}) {
  return {
    uuid: `test-${++_counter}`,
    filePath: 'notes/test.md',
    type: 'highlight',
    color: 'yellow',
    text: 'Hello World',
    note: '',
    tags: [],
    startOffset: 0,
    endOffset: 11,
    startLine: 1,
    contextBefore: '',
    contextAfter: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ─── Import Store ──────────────────────────────────────

async function runTests() {
  // Use esbuild to compile, then dynamic import
  const { AnnotationStore } = await import('../src/db/annotation-store');

  let passed = 0;
  let failed = 0;

  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
      console.log(`  ✅ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ❌ ${name}: ${err.message}`);
    }
  };

  console.log('\n🧪 AnnotationStore Unit Tests\n');

  // ─── Basic CRUD ───────────────────────────────────

  await test('add + get by uuid', async () => {
    const store = new AnnotationStore();
    const vault = createMockVault();
    store.init(vault);
    await store.initialize();

    const ann = makeAnnotation();
    await store.addAnnotation(ann);

    const found = store.getAnnotationByUuid(ann.uuid);
    if (!found) throw new Error('should find annotation by uuid');
    if (found.uuid !== ann.uuid) throw new Error('uuid should match');
  });

  await test('add + get by file', async () => {
    const store = new AnnotationStore();
    const vault = createMockVault();
    store.init(vault);
    await store.initialize();

    await store.addAnnotation(makeAnnotation({ uuid: 'a1', filePath: 'notes/test.md' }));
    await store.addAnnotation(makeAnnotation({ uuid: 'a2', filePath: 'notes/test.md' }));
    await store.addAnnotation(makeAnnotation({ uuid: 'a3', filePath: 'notes/other.md' }));

    const testAnns = store.getAnnotationsForFile('notes/test.md');
    if (testAnns.length !== 2) throw new Error(`should have 2, got ${testAnns.length}`);

    const otherAnns = store.getAnnotationsForFile('notes/other.md');
    if (otherAnns.length !== 1) throw new Error(`should have 1, got ${otherAnns.length}`);
  });

  await test('update annotation', async () => {
    const store = new AnnotationStore();
    const vault = createMockVault();
    store.init(vault);
    await store.initialize();

    await store.addAnnotation(makeAnnotation({ uuid: 'u1', note: 'original' }));
    await store.updateAnnotation('u1', { note: 'updated' });

    const found = store.getAnnotationByUuid('u1');
    if (found.note !== 'updated') throw new Error(`note should be 'updated', got '${found.note}'`);
  });

  await test('delete annotation', async () => {
    const store = new AnnotationStore();
    const vault = createMockVault();
    store.init(vault);
    await store.initialize();

    await store.addAnnotation(makeAnnotation({ uuid: 'd1' }));
    if (!store.getAnnotationByUuid('d1')) throw new Error('should exist after add');

    await store.deleteAnnotation('d1');
    if (store.getAnnotationByUuid('d1')) throw new Error('should not exist after delete');
  });

  // ─── Index Consistency ─────────────────────────────

  await test('index consistency after add/delete', async () => {
    const store = new AnnotationStore();
    const vault = createMockVault();
    store.init(vault);
    await store.initialize();

    await store.addAnnotation(makeAnnotation({ uuid: 'idx1', filePath: 'notes/idx.md' }));

    const byUuid = store.getAnnotationByUuid('idx1');
    if (!byUuid) throw new Error('should be in _byUuid');

    const byFile = store.getAnnotationsForFile('notes/idx.md');
    if (byFile.length !== 1) throw new Error('should be in _byFile');

    await store.deleteAnnotation('idx1');
    if (store.getAnnotationByUuid('idx1')) throw new Error('should be removed from _byUuid');
    if (store.getAnnotationsForFile('notes/idx.md').length !== 0) throw new Error('should be removed from _byFile');
  });

  // ─── _stripExtraFields ─────────────────────────────

  await test('_stripExtraFields removes _source and _needsUpgrade', async () => {
    const store = new AnnotationStore();
    const vault = createMockVault();
    store.init(vault);
    await store.initialize();

    const dirty = makeAnnotation({ _source: 'markdown', _needsUpgrade: true, uuid: 'clean1' });
    await store.addAnnotation(dirty);

    const found = store.getAnnotationByUuid('clean1');
    if (!found) throw new Error('should exist');
    if ('_source' in found) throw new Error('should not have _source');
    if ('_needsUpgrade' in found) throw new Error('should not have _needsUpgrade');
  });

  // ─── Query / Filter ────────────────────────────────

  await test('query by type', async () => {
    const store = new AnnotationStore();
    const vault = createMockVault();
    store.init(vault);
    await store.initialize();

    await store.addAnnotation(makeAnnotation({ uuid: 'q1', type: 'highlight' }));
    await store.addAnnotation(makeAnnotation({ uuid: 'q2', type: 'bold' }));
    await store.addAnnotation(makeAnnotation({ uuid: 'q3', type: 'highlight' }));

    const highlights = store.queryAnnotations({ type: 'highlight' });
    if (highlights.length !== 2) throw new Error(`should find 2 highlights, got ${highlights.length}`);
  });

  await test('query by color', async () => {
    const store = new AnnotationStore();
    const vault = createMockVault();
    store.init(vault);
    await store.initialize();

    await store.addAnnotation(makeAnnotation({ uuid: 'c1', color: 'yellow' }));
    await store.addAnnotation(makeAnnotation({ uuid: 'c2', color: 'green' }));
    await store.addAnnotation(makeAnnotation({ uuid: 'c3', color: 'yellow' }));

    const yellow = store.queryAnnotations({ color: 'yellow' });
    if (yellow.length !== 2) throw new Error(`should find 2 yellow, got ${yellow.length}`);
  });

  await test('query with text search', async () => {
    const store = new AnnotationStore();
    const vault = createMockVault();
    store.init(vault);
    await store.initialize();

    await store.addAnnotation(makeAnnotation({ uuid: 's1', text: 'Hello World' }));
    await store.addAnnotation(makeAnnotation({ uuid: 's2', text: 'Goodbye Moon' }));

    const results = store.queryAnnotations({ searchQuery: 'hello' });
    if (results.length !== 1) throw new Error(`should find 1, got ${results.length}`);
    if (results[0].uuid !== 's1') throw new Error('should find the right annotation');
  });

  // ─── Shard Persistence ─────────────────────────────

  await test('flushAll writes shard + index + meta', async () => {
    const store = new AnnotationStore();
    const vault = createMockVault();
    store.init(vault);
    await store.initialize();

    await store.addAnnotation(makeAnnotation({ uuid: 'p1', filePath: 'notes/persist.md' }));
    await store.flushAll();

    if (!vault.adapter.files.has('.obsidian/plugins/markvault-js/_index.json'))
      throw new Error('index file should exist after flushAll');
    if (!vault.adapter.files.has('.obsidian/plugins/markvault-js/_meta.json'))
      throw new Error('meta file should exist after flushAll');
  });

  // ─── Lazy Loading ─────────────────────────────────

  await test('ensureFileLoaded loads from shard', async () => {
    const store1 = new AnnotationStore();
    const vault = createMockVault();
    store1.init(vault);
    await store1.initialize();

    // Add and flush
    await store1.addAnnotation(makeAnnotation({ uuid: 'll1', filePath: 'notes/lazy.md' }));
    await store1.flushAll();

    // Create new store instance, should load from shard
    const store2 = new AnnotationStore();
    store2.init(vault);
    await store2.initialize();

    // Before ensureFileLoaded, annotation shouldn't be in memory
    if (store2.getAnnotationByUuid('ll1')) throw new Error('should not be loaded yet');

    // After ensureFileLoaded, annotation should be available
    await store2.ensureFileLoaded('notes/lazy.md');
    const found = store2.getAnnotationByUuid('ll1');
    if (!found) throw new Error('should be loaded from shard');
  });

  // ─── Summary ───────────────────────────────────────

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
