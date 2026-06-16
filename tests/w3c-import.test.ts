/**
 * W3C 导入测试
 *
 * 测试 importFromW3C 的核心场景：
 * 1. 基本导入流程
 * 2. UUID 冲突处理
 * 3. filePath 映射
 * 4. Relations 批量重建
 * 5. Flags 类型校验
 * 6. 无效数据降级
 */

import { AnnotationStore } from '../src/db/annotation-store';
import type { Annotation } from '../src/types/annotation';
import type { W3CAnnotation, W3CAnnotationCollection } from '../src/export/w3c-types';
import { importFromW3C, importFromW3CString, importSingleFromW3C } from '../src/export/w3c-import';
import { exportToW3C, exportToW3CString } from '../src/export/w3c-export';

// ─── 测试工具 ──────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

function assertEqual(actual: any, expected: any, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    uuid: overrides.uuid || crypto.randomUUID(),
    filePath: overrides.filePath || 'notes/test.md',
    type: overrides.type || 'highlight',
    color: overrides.color || 'yellow',
    text: overrides.text || 'test text',
    note: overrides.note || '',
    tags: overrides.tags || [],
    startOffset: overrides.startOffset ?? 0,
    endOffset: overrides.endOffset ?? 10,
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine,
    contextBefore: overrides.contextBefore || '',
    contextAfter: overrides.contextAfter || '',
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
    ...overrides,
  };
}

function makeW3CCollection(items: W3CAnnotation[]): W3CAnnotationCollection {
  return {
    '@context': ['http://www.w3.org/ns/anno.jsonld', 'http://www.w3.org/ns/ldp.jsonld'],
    id: 'markvault:collection',
    type: 'AnnotationCollection',
    total: items.length,
    items,
  };
}

function makeW3CAnnotation(overrides: Partial<W3CAnnotation> = {}): W3CAnnotation {
  const uuid = overrides.id?.split(':').pop() || crypto.randomUUID();
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    id: `markvault:${uuid}`,
    type: 'Annotation',
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    target: { source: 'notes/test.md' },
    'markvault:type': 'highlight',
    'markvault:color': 'yellow',
    'markvault:kind': 'inline',
    ...overrides,
  };
}

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

async function createStore(): Promise<AnnotationStore> {
  const store = new AnnotationStore();
  store.init(createMockVault() as any);
  await store.initialize();
  return store;
}

// ─── 测试 ──────────────────────────────────

async function runTests() {
  console.log('\n📦 W3C Import Tests');
  console.log('═══════════════════════════════════════════════════════\n');

  // ── 1. 基本导入 ──
  console.log('1️⃣  Basic import');

  {
    const store = await createStore();
    const uuid1 = crypto.randomUUID();
    const w3c = makeW3CAnnotation({ id: `markvault:${uuid1}` });

    const result = await importFromW3C(store, makeW3CCollection([w3c]));

    assertEqual(result.imported, 1, 'imports 1 annotation');
    assertEqual(result.errors, 0, 'no errors');
    assertEqual(result.skipped, 0, 'no skipped');

    const ann = store.getAnnotationByUuid(uuid1);
    assert(ann !== undefined, 'annotation exists in store');
    assertEqual(ann?.type, 'highlight', 'type preserved');
  }

  // ── 2. UUID 冲突: regenerate ──
  console.log('\n2️⃣  UUID conflict: regenerate');

  {
    const store = await createStore();
    const uuid1 = crypto.randomUUID();

    // 先添加一条
    await store.addAnnotation(makeAnnotation({ uuid: uuid1, text: 'original' }));

    // 导入同 UUID 的 W3C 标注
    const w3c = makeW3CAnnotation({
      id: `markvault:${uuid1}`,
      'markvault:type': 'bold',
    });
    const result = await importFromW3C(store, makeW3CCollection([w3c]), {
      uuidConflict: 'regenerate',
    });

    assertEqual(result.imported, 1, 'imported with new UUID');
    assertEqual(result.uuidRemap.size, 1, 'uuidRemap has 1 entry');
    assert(result.uuidRemap.has(uuid1), 'uuidRemap contains original UUID');

    // 原始标注仍然存在
    const orig = store.getAnnotationByUuid(uuid1);
    assertEqual(orig?.text, 'original', 'original annotation preserved');

    // 新标注用重映射后的 UUID 存在
    const newUuid = result.uuidRemap.get(uuid1)!;
    const imported = store.getAnnotationByUuid(newUuid);
    assert(imported !== undefined, 'imported annotation exists with new UUID');
  }

  // ── 3. UUID 冲突: skip ──
  console.log('\n3️⃣  UUID conflict: skip');

  {
    const store = await createStore();
    const uuid1 = crypto.randomUUID();

    await store.addAnnotation(makeAnnotation({ uuid: uuid1 }));

    const w3c = makeW3CAnnotation({ id: `markvault:${uuid1}` });
    const result = await importFromW3C(store, makeW3CCollection([w3c]), {
      uuidConflict: 'skip',
    });

    assertEqual(result.skipped, 1, 'skipped 1 conflict');
    assertEqual(result.imported, 0, 'imported 0');
  }

  // ── 4. UUID 冲突: preserve ──
  console.log('\n4️⃣  UUID conflict: preserve');

  {
    const store = await createStore();
    const uuid1 = crypto.randomUUID();

    await store.addAnnotation(makeAnnotation({ uuid: uuid1 }));

    const w3c = makeW3CAnnotation({ id: `markvault:${uuid1}` });
    const result = await importFromW3C(store, makeW3CCollection([w3c]), {
      uuidConflict: 'preserve',
    });

    assertEqual(result.skipped, 1, 'skipped (preserve = skip if exists)');
    assertEqual(result.imported, 0, 'imported 0');
  }

  // ── 5. filePath 映射 ──
  console.log('\n5️⃣  filePath mapping');

  {
    const store = await createStore();
    const uuid1 = crypto.randomUUID();

    const w3c = makeW3CAnnotation({
      id: `markvault:${uuid1}`,
      target: { source: 'old/path/note.md' },
    });
    const result = await importFromW3C(store, makeW3CCollection([w3c]), {
      filePathMap: { 'old/path/note.md': 'new/vault/note.md' },
    });

    assertEqual(result.imported, 1, 'imported with mapped path');
    const ann = store.getAnnotationByUuid(uuid1);
    assertEqual(ann?.filePath, 'new/vault/note.md', 'filePath mapped correctly');
  }

  // ── 6. Relations UUID 重映射 ──
  console.log('\n6️⃣  Relations UUID remapping');

  {
    const store = await createStore();
    const uuid1 = crypto.randomUUID();
    const uuid2 = crypto.randomUUID();

    // 两条标注，uuid1 关联 uuid2，但 uuid1 已存在 → 重映射
    await store.addAnnotation(makeAnnotation({ uuid: uuid1, text: 'existing' }));

    const w3c1 = makeW3CAnnotation({
      id: `markvault:${uuid1}`,
      'markvault:relations': [{ targetUuid: uuid2, type: 'references', createdAt: new Date().toISOString(), source: 'manual' }],
    });
    const w3c2 = makeW3CAnnotation({
      id: `markvault:${uuid2}`,
    });

    const result = await importFromW3C(store, makeW3CCollection([w3c1, w3c2]), {
      uuidConflict: 'regenerate',
    });

    assertEqual(result.imported, 2, 'imported 2 annotations');
    assertEqual(result.uuidRemap.size, 1, '1 UUID remapped (uuid1)');

    // uuid2 未冲突，应保留原 UUID
    const ann2 = store.getAnnotationByUuid(uuid2);
    assert(ann2 !== undefined, 'uuid2 imported with original UUID');

    // uuid1 被重映射，关联中的 targetUuid 也应更新
    const newUuid1 = result.uuidRemap.get(uuid1)!;
    const ann1 = store.getAnnotationByUuid(newUuid1);
    assert(ann1 !== undefined, 'remapped uuid1 exists');
    // relations 应该仍指向 uuid2（未变）
    assert(ann1!.relations !== undefined, 'relations preserved');
  }

  // ── 7. Flags 类型校验（非法值被过滤） ──
  console.log('\n7️⃣  Flags type validation');

  {
    const store = await createStore();
    const uuid1 = crypto.randomUUID();

    const w3c = makeW3CAnnotation({
      id: `markvault:${uuid1}`,
      'markvault:flags': {
        mastery: 'invalid_level',  // 非法值
        reviewPriority: 'high',     // 合法值
        confidence: 99,             // 超出范围
        needsCorrection: true,
      },
    });

    const result = await importFromW3C(store, makeW3CCollection([w3c]));
    assertEqual(result.imported, 1, 'imported 1 annotation');

    const ann = store.getAnnotationByUuid(uuid1);
    assert(ann?.flags !== undefined, 'flags exist');
    assertEqual(ann?.flags?.mastery, undefined, 'invalid mastery filtered out');
    assertEqual(ann?.flags?.reviewPriority, 'high', 'valid reviewPriority preserved');
    assertEqual(ann?.flags?.confidence, undefined, 'out-of-range confidence filtered out');
    assertEqual(ann?.flags?.needsCorrection, true, 'needsCorrection preserved');
  }

  // ── 8. importRelations: false ──
  console.log('\n8️⃣  importRelations: false');

  {
    const store = await createStore();
    const uuid1 = crypto.randomUUID();

    const w3c = makeW3CAnnotation({
      id: `markvault:${uuid1}`,
      'markvault:relations': [{ targetUuid: 'other-uuid', type: 'references', createdAt: new Date().toISOString() }],
    });

    const result = await importFromW3C(store, makeW3CCollection([w3c]), {
      importRelations: false,
    });

    assertEqual(result.imported, 1, 'imported without relations');
    const ann = store.getAnnotationByUuid(uuid1);
    assertEqual(ann?.relations, undefined, 'relations excluded');
  }

  // ── 9. importFromW3CString 便捷方法 ──
  console.log('\n9️⃣  importFromW3CString convenience');

  {
    const store = await createStore();
    const uuid1 = crypto.randomUUID();

    const collection = makeW3CCollection([
      makeW3CAnnotation({ id: `markvault:${uuid1}` }),
    ]);
    const jsonStr = JSON.stringify(collection);

    const result = await importFromW3CString(store, jsonStr);
    assertEqual(result.imported, 1, 'imported from string');
  }

  // ── 10. importSingleFromW3C ──
  console.log('\n🔟 importSingleFromW3C');

  {
    const store = await createStore();
    const uuid1 = crypto.randomUUID();

    const w3c = makeW3CAnnotation({ id: `markvault:${uuid1}` });
    const result = await importSingleFromW3C(store, w3c);

    assertEqual(result.imported, 1, 'imported single annotation');
  }

  // ── 11. 往返测试：导出再导入 ──
  console.log('\n1️⃣1️⃣  Round-trip: export then import');

  {
    const store1 = await createStore();
    const uuid1 = crypto.randomUUID();
    await store1.addAnnotation(makeAnnotation({
      uuid: uuid1,
      text: 'round trip test',
      note: 'important note',
      tags: ['test'],
      motivation: 'commenting',
      flags: { mastery: 'learning', confidence: 3, needsCorrection: false },
      relations: [],
      groups: ['ch1'],
    }));

    // 导出
    const exported = exportToW3CString(store1, {});
    const exportData = JSON.parse(exported);
    assertEqual(exportData.type, 'AnnotationCollection', 'exported is Collection');

    // 导入到新 Store
    const store2 = await createStore();
    const result = await importFromW3CString(store2, exported);

    assertEqual(result.imported, 1, 'round-trip imported 1');
    assertEqual(result.errors, 0, 'no errors in round-trip');

    const ann = store2.getAnnotationByUuid(uuid1);
    assert(ann !== undefined, 'round-trip annotation exists');
    assertEqual(ann?.text, 'round trip test', 'text preserved');
    assertEqual(ann?.note, 'important note', 'note preserved');
    assertEqual(ann?.flags?.mastery, 'learning', 'mastery preserved');
    assertEqual(ann?.flags?.confidence, 3, 'confidence preserved');
    assertEqual(ann?.flags?.needsCorrection, false, 'needsCorrection=false preserved');
  }

  // ── 12. 空集合导入 ──
  console.log('\n1️⃣2️⃣  Empty collection import');

  {
    const store = await createStore();
    const result = await importFromW3C(store, makeW3CCollection([]));

    assertEqual(result.imported, 0, 'imported 0 from empty');
    assertEqual(result.errors, 0, 'no errors');
  }

  // ── 13. 分页集合导入（只有 first page） ──
  console.log('\n1️⃣3️⃣  Paginated collection import');

  {
    const store = await createStore();
    const uuid1 = crypto.randomUUID();

    // 模拟分页集合（只有 first page 内联）
    const collection: W3CAnnotationCollection = {
      '@context': ['http://www.w3.org/ns/anno.jsonld'],
      id: 'paginated-collection',
      type: 'AnnotationCollection',
      total: 3,
      first: {
        '@context': ['http://www.w3.org/ns/anno.jsonld'],
        id: 'paginated-collection/page1',
        type: 'AnnotationPage',
        partOf: 'paginated-collection',
        startIndex: 0,
        items: [makeW3CAnnotation({ id: `markvault:${uuid1}` })],
      },
      last: {
        '@context': ['http://www.w3.org/ns/anno.jsonld'],
        id: 'paginated-collection/page2',
        type: 'AnnotationPage',
        partOf: 'paginated-collection',
        startIndex: 1,
        items: [],
      },
    };

    const result = await importFromW3C(store, collection);
    // 只有 first page 的 items 被导入
    assertEqual(result.imported, 1, 'imported from first page only');
  }

  // ── 14. relationSource 标记 ──
  console.log('\n1️⃣4️⃣  relationSource marking');

  {
    const store = await createStore();
    const uuid1 = crypto.randomUUID();

    const w3c = makeW3CAnnotation({
      id: `markvault:${uuid1}`,
      'markvault:relations': [{ targetUuid: 'target-uuid', type: 'references', createdAt: new Date().toISOString() }],
    });

    const result = await importFromW3C(store, makeW3CCollection([w3c]), {
      relationSource: 'imported',
    });

    assertEqual(result.imported, 1, 'imported with source marking');
    const ann = store.getAnnotationByUuid(uuid1);
    assertEqual(ann?.relations?.[0]?.source, 'imported', 'relation source marked as imported');
  }

  // ── 汇总 ──
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`\n📊 结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
  if (failed === 0) {
    console.log('✅ 所有测试通过！');
  } else {
    console.log('❌ 有测试失败');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
