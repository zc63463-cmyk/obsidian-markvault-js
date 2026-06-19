/**
 * PDF 标注扩展测试 — Phase 1 MVP
 *
 * 验证范围：
 * 1. PDF 标注 CRUD → byUuid / byFile / byDocType 索引正确
 * 2. PDF 标注 update → 索引同步更新
 * 3. PDF 标注 delete → 索引清理 + 关系级联
 * 4. PDF 标注 + Markdown 标注共存（同文件路径，不同 docType）
 * 5. PDF 标注创建关系 → 复用关系引擎，反向关系自动创建
 * 6. PDF 标注 selector 持久化 → stripExtraFields 不丢失
 * 7. PDF 标注 W3C 序列化往返无损
 * 8. getAnnotationsForFile 对 PDF 标注按 createdAt 排序
 */

import { AnnotationStore } from '../src/db/annotation-store';
import { stripExtraFields } from '../src/db/strip-fields';
import { serializeAnnotation, deserializeAnnotation } from '../src/export/w3c-serializer';
import type { Annotation, PDFSelector, PDFRect, AnnotationRelation, PercentRect } from '../src/types/annotation';

// ─── Mock DataAdapter (与现有测试一致) ─────────────────

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

// ─── Test helpers ──────────────────────────────────────

let _c = 0;

/** 创建 Markdown 标注（默认 docType='markdown'） */
function makeMdAnn(overrides: Partial<Annotation> = {}): Annotation {
  return {
    uuid: `md-${++_c}`,
    filePath: 'notes/test.md',
    type: 'highlight',
    color: 'yellow',
    text: 'Hello Markdown',
    note: '',
    tags: [],
    startOffset: 0,
    endOffset: 14,
    startLine: 1,
    contextBefore: '',
    contextAfter: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Annotation;
}

/** 创建 PDF 标注（docType='pdf', selector=PDFSelector） */
function makePdfAnn(overrides: Partial<Annotation> = {}): Annotation {
  const rects: PDFRect[] = [
    { x1: 100, y1: 200, x2: 300, y2: 220 },
  ];
  const percentRects: PercentRect[] = [
    { x: 10, y: 20, width: 30, height: 5 },
  ];
  const selector: PDFSelector = {
    type: 'pdf',
    page: 0,
    rects,
    percentRects,
    textHash: 'abc123',
  };
  return {
    uuid: `pdf-${++_c}`,
    filePath: 'books/textbook.pdf',
    type: 'highlight',
    color: 'blue',
    text: '',  // PDF 标注默认留空
    note: '',
    tags: [],
    startOffset: 0,  // PDF 标注无意义但需存在（兼容字段）
    endOffset: 0,
    startLine: 0,
    contextBefore: '',
    contextAfter: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    docType: 'pdf',
    selector,
    ...overrides,
  } as Annotation;
}

function assertEqual(actual: unknown, expected: unknown, msg?: string): void {
  if (actual !== expected) {
    throw new Error(`${msg ?? 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNotNull<T>(val: T | null | undefined, msg?: string): asserts val is T {
  if (val === null || val === undefined) throw new Error(msg ?? 'value is null/undefined');
}

// ─── Tests ─────────────────────────────────────────────

async function runTests() {
  let passed = 0, failed = 0;
  const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); passed++; console.log(`  \u2705 ${name}`); }
    catch (e: any) { failed++; console.log(`  \u274c ${name}: ${e.message}`); }
  };

  console.log('\n\u{1F9EA} PDF \u6807\u6CE8\u6269\u5C55\u6D4B\u8BD5 \u2014 Phase 1 MVP\n');

  // ═══════════════════════════════════════════════════════
  // 1. PDF 标注 add → 索引正确 (byUuid / byFile / byDocType)
  // ═══════════════════════════════════════════════════════

  console.log('\u2500\u2500 1. PDF \u6807\u6CE8 add \u2192 \u7D22\u5F15\u6B63\u786E \u2500\u2500');

  await test('PDF \u6807\u6CE8 add \u2192 byUuid \u7D22\u5F15\u6B63\u786E', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    const pdf = makePdfAnn({ uuid: 'pdf-001' });
    await s.addAnnotation(pdf);
    const found = s.getAnnotationByUuid('pdf-001');
    assertNotNull(found, 'PDF annotation not found by uuid');
    assertEqual(found.uuid, 'pdf-001');
    assertEqual(found.docType, 'pdf');
  });

  await test('PDF \u6807\u6CE8 add \u2192 byFile \u7D22\u5F15\u6B63\u786E', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makePdfAnn({ uuid: 'pdf-f1', filePath: 'books/a.pdf' }));
    await s.addAnnotation(makePdfAnn({ uuid: 'pdf-f2', filePath: 'books/a.pdf' }));
    await s.addAnnotation(makePdfAnn({ uuid: 'pdf-f3', filePath: 'books/b.pdf' }));
    const aList = s.getAnnotationsForFile('books/a.pdf');
    assertEqual(aList.length, 2, 'a.pdf should have 2 annotations');
    const bList = s.getAnnotationsForFile('books/b.pdf');
    assertEqual(bList.length, 1, 'b.pdf should have 1 annotation');
  });

  await test('PDF \u6807\u6CE8 add \u2192 byDocType \u7D22\u5F15\u6B63\u786E', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makePdfAnn({ uuid: 'pdf-d1' }));
    await s.addAnnotation(makePdfAnn({ uuid: 'pdf-d2' }));
    await s.addAnnotation(makeMdAnn({ uuid: 'md-d1' }));

    const pdfSet = s.indexLayer.getAnnotationsByDocType('pdf');
    assertEqual(pdfSet.size, 2, 'byDocType(pdf) should have 2');
    const mdSet = s.indexLayer.getAnnotationsByDocType('markdown');
    assertEqual(mdSet.size, 1, 'byDocType(markdown) should have 1');
  });

  // ═══════════════════════════════════════════════════════
  // 2. PDF 标注 update → 索引同步更新
  // ═══════════════════════════════════════════════════════

  console.log('\u2500\u2500 2. PDF \u6807\u6CE8 update \u2192 \u7D22\u5F15\u540C\u6B65\u66F4\u65B0 \u2500\u2500');

  await test('PDF \u6807\u6CE8 update note/color \u2192 byUuid \u53CD\u6620\u66F4\u65B0', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makePdfAnn({ uuid: 'pdf-u1', note: 'old note', color: 'blue' }));
    await s.updateAnnotation('pdf-u1', { note: 'new note', color: 'green' });
    const found = s.getAnnotationByUuid('pdf-u1');
    assertNotNull(found);
    assertEqual(found.note, 'new note');
    assertEqual(found.color, 'green');
    // docType 和 selector 不应丢失
    assertEqual(found.docType, 'pdf');
    assertNotNull(found.selector);
  });

  await test('PDF \u6807\u6CE8 update selector (page change) \u2192 selector \u66F4\u65B0', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makePdfAnn({ uuid: 'pdf-u2' }));
    const newSelector: PDFSelector = {
      type: 'pdf',
      page: 5,
      rects: [{ x1: 50, y1: 100, x2: 200, y2: 120 }],
    };
    await s.updateAnnotation('pdf-u2', { selector: newSelector });
    const found = s.getAnnotationByUuid('pdf-u2');
    assertNotNull(found);
    const sel = found.selector as PDFSelector;
    assertEqual(sel.page, 5, 'page should be updated to 5');
    assertEqual(sel.rects.length, 1);
  });

  await test('PDF \u6807\u6CE8 update filePath \u2192 byFile \u7D22\u5F15\u8FC1\u79FB', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makePdfAnn({ uuid: 'pdf-u3', filePath: 'books/old.pdf' }));
    await s.updateAnnotation('pdf-u3', { filePath: 'books/new.pdf' });
    assertEqual(s.getAnnotationsForFile('books/old.pdf').length, 0, 'old.pdf should be empty');
    assertEqual(s.getAnnotationsForFile('books/new.pdf').length, 1, 'new.pdf should have 1');
  });

  // ═══════════════════════════════════════════════════════
  // 3. PDF 标注 delete → 索引清理 + 关系级联
  // ═══════════════════════════════════════════════════════

  console.log('\u2500\u2500 3. PDF \u6807\u6CE8 delete \u2192 \u7D22\u5F15\u6E05\u7406 + \u5173\u7CFB\u7EA7\u8054 \u2500\u2500');

  await test('PDF \u6807\u6CE8 delete \u2192 byUuid/byFile/byDocType \u5168\u90E8\u6E05\u7406', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makePdfAnn({ uuid: 'pdf-del1', filePath: 'books/del.pdf' }));

    // 确认存在
    assertNotNull(s.getAnnotationByUuid('pdf-del1'));
    assertEqual(s.getAnnotationsForFile('books/del.pdf').length, 1);
    assertEqual(s.indexLayer.getAnnotationsByDocType('pdf').size, 1);

    // 删除
    await s.deleteAnnotation('pdf-del1');

    // 确认清理
    assertEqual(s.getAnnotationByUuid('pdf-del1'), undefined, 'should be removed from byUuid');
    assertEqual(s.getAnnotationsForFile('books/del.pdf').length, 0, 'should be removed from byFile');
    assertEqual(s.indexLayer.getAnnotationsByDocType('pdf').size, 0, 'should be removed from byDocType');
  });

  await test('PDF \u6807\u6CE8 delete \u2192 \u5173\u7CFB\u7EA7\u8054\u6E05\u7406', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    const pdf1 = makePdfAnn({ uuid: 'pdf-rel1', filePath: 'books/rel.pdf' });
    const pdf2 = makePdfAnn({ uuid: 'pdf-rel2', filePath: 'books/rel.pdf' });
    await s.addAnnotation(pdf1);
    await s.addAnnotation(pdf2);

    // pdf-rel1 elaborates pdf-rel2
    const rel: AnnotationRelation = {
      targetUuid: 'pdf-rel2',
      type: 'elaborates',
      createdAt: Date.now(),
      source: 'manual',
    };
    await s.addRelation('pdf-rel1', rel);

    // 确认关系存在
    const before = s.getRelations('pdf-rel1');
    assertEqual(before.outgoing.length, 1, 'pdf-rel1 should have 1 outgoing relation');

    // 删除 pdf-rel2 → pdf-rel1 的出边关系应被级联清理
    await s.deleteAnnotation('pdf-rel2');
    const after = s.getRelations('pdf-rel1');
    assertEqual(after.outgoing.length, 0, 'pdf-rel1 outgoing relation should be cascade-cleaned');
  });

  // ═══════════════════════════════════════════════════════
  // 4. PDF + Markdown 标注共存（同文件路径，不同 docType）
  // ═══════════════════════════════════════════════════════

  console.log('\u2500\u2500 4. PDF + Markdown \u5171\u5B58 \u2500\u2500');

  await test('\u540C\u6587\u4EF6\u8DEF\u5F84\u53EF\u540C\u65F6\u5B58\u5728 PDF \u548C Markdown \u6807\u6CE8', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    // 同一路径下混合标注（虽然实际场景不常见，但验证索引隔离）
    await s.addAnnotation(makePdfAnn({ uuid: 'mix-pdf', filePath: 'mixed/doc.pdf' }));
    await s.addAnnotation(makeMdAnn({ uuid: 'mix-md', filePath: 'mixed/doc.pdf' }));

    const all = s.getAnnotationsForFile('mixed/doc.pdf');
    assertEqual(all.length, 2, 'should have 2 annotations for same file');

    const pdfCount = all.filter(a => a.docType === 'pdf').length;
    const mdCount = all.filter(a => a.docType === 'markdown' || !a.docType).length;
    assertEqual(pdfCount, 1, 'should have 1 pdf annotation');
    assertEqual(mdCount, 1, 'should have 1 markdown annotation');

    // byDocType 索引隔离
    assertEqual(s.indexLayer.getAnnotationsByDocType('pdf').size, 1);
    assertEqual(s.indexLayer.getAnnotationsByDocType('markdown').size, 1);
  });

  await test('\u5220\u9664 PDF \u6807\u6CE8\u4E0D\u5F71\u54CD\u540C\u6587\u4EF6\u7684 Markdown \u6807\u6CE8', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makePdfAnn({ uuid: 'iso-pdf', filePath: 'mixed/iso.pdf' }));
    await s.addAnnotation(makeMdAnn({ uuid: 'iso-md', filePath: 'mixed/iso.pdf' }));

    await s.deleteAnnotation('iso-pdf');

    assertEqual(s.getAnnotationsForFile('mixed/iso.pdf').length, 1, 'markdown annotation should survive');
    const survivor = s.getAnnotationByUuid('iso-md');
    assertNotNull(survivor, 'markdown annotation should still exist');
  });

  // ═══════════════════════════════════════════════════════
  // 5. PDF 标注创建关系 → 复用关系引擎，反向关系自动创建
  // ═══════════════════════════════════════════════════════

  console.log('\u2500\u2500 5. PDF \u6807\u6CE8\u5173\u7CFB \u2192 \u590D\u7528\u5173\u7CFB\u5F15\u64CE \u2500\u2500');

  await test('PDF\u2192PDF \u5173\u7CFB\u521B\u5EFA \u2192 \u53CD\u5411\u5173\u7CFB\u81EA\u52A8\u751F\u6210', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makePdfAnn({ uuid: 'pdf-r1', filePath: 'books/r.pdf' }));
    await s.addAnnotation(makePdfAnn({ uuid: 'pdf-r2', filePath: 'books/r.pdf' }));

    // pdf-r1 elaborates pdf-r2 → pdf-r2 should get "isElaboratedBy" reverse (as outgoing on pdf-r2)
    const rel: AnnotationRelation = {
      targetUuid: 'pdf-r2',
      type: 'elaborates',
      createdAt: Date.now(),
      source: 'manual',
    };
    await s.addRelation('pdf-r1', rel);

    // 检查正向 (pdf-r1 outgoing)
    const r1Out = s.getRelations('pdf-r1').outgoing;
    assertEqual(r1Out.length, 1, 'pdf-r1 should have 1 outgoing');
    assertEqual(r1Out[0].type, 'elaborates');
    assertEqual(r1Out[0].targetUuid, 'pdf-r2');

    // 检查反向关系: pdf-r2 上应有 isElaboratedBy → pdf-r1 (作为 pdf-r2 的 outgoing)
    const r2Out = s.getRelations('pdf-r2').outgoing;
    assertEqual(r2Out.length, 1, 'pdf-r2 should have 1 outgoing (the reverse relation)');
    assertEqual(r2Out[0].type, 'isElaboratedBy', 'reverse type should be isElaboratedBy');
    assertEqual(r2Out[0].targetUuid, 'pdf-r1');

    // 检查 incoming (pdf-r2 的 incoming 是 pdf-r1 的正向关系)
    const r2In = s.getRelations('pdf-r2').incoming;
    assertEqual(r2In.length, 1, 'pdf-r2 should have 1 incoming');
    assertEqual(r2In[0].sourceUuid, 'pdf-r1');
    assertEqual(r2In[0].relation.type, 'elaborates');
  });

  await test('PDF\u2192Markdown \u8DE8\u6587\u6863\u7C7B\u578B\u5173\u7CFB \u2192 \u5173\u7CFB\u5F15\u64CE\u6B63\u5E38\u5904\u7406', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makePdfAnn({ uuid: 'pdf-x1', filePath: 'books/x.pdf' }));
    await s.addAnnotation(makeMdAnn({ uuid: 'md-x1', filePath: 'notes/x.md' }));

    // PDF 标注 contradicts MD 标注
    const rel: AnnotationRelation = {
      targetUuid: 'md-x1',
      type: 'contradicts',
      createdAt: Date.now(),
      source: 'manual',
    };
    await s.addRelation('pdf-x1', rel);

    const outgoing = s.getRelations('pdf-x1').outgoing;
    assertEqual(outgoing.length, 1);
    assertEqual(outgoing[0].targetUuid, 'md-x1');

    const incoming = s.getRelations('md-x1').incoming;
    assertEqual(incoming.length, 1, 'md-x1 should have incoming from pdf annotation');
    assertEqual(incoming[0].sourceUuid, 'pdf-x1');
  });

  // ═══════════════════════════════════════════════════════
  // 6. PDF 标注 selector 持久化 → stripExtraFields 不丢失
  // ═══════════════════════════════════════════════════════

  console.log('\u2500\u2500 6. PDF selector \u6301\u4E45\u5316 \u2192 stripExtraFields \u4E0D\u4E22\u5931 \u2500\u2500');

  await test('stripExtraFields \u4FDD\u7559 docType + selector \u5B57\u6BB5', () => {
    const pdf = makePdfAnn({ uuid: 'pdf-strip1' });
    const stripped = stripExtraFields(pdf);

    assertEqual(stripped.docType, 'pdf', 'docType should survive stripExtraFields');
    assertNotNull(stripped.selector, 'selector should survive stripExtraFields');

    const sel = stripped.selector as PDFSelector;
    assertEqual(sel.type, 'pdf');
    assertEqual(sel.page, 0);
    assertEqual(sel.rects.length, 1);
    assertEqual(sel.rects[0].x1, 100);
    assertEqual(sel.rects[0].y2, 220);
    assertEqual(sel.textHash, 'abc123');
    // percentRects 也应保留
    assertNotNull(sel.percentRects, 'percentRects should survive stripExtraFields');
    assertEqual(sel.percentRects!.length, 1);
    assertEqual(sel.percentRects![0].x, 10);
    assertEqual(sel.percentRects![0].width, 30);
  });

  await test('stripExtraFields \u6E05\u7406\u4E34\u65F6\u6807\u8BB0\u4F46\u4FDD\u7559 PDF \u5B57\u6BB5', () => {
    const pdf = makePdfAnn({ uuid: 'pdf-strip2' });
    // 注入临时标记
    (pdf as any)._temp = 'should-be-stripped';
    (pdf as any)._source = 'temp';

    const stripped = stripExtraFields(pdf);
    assertEqual((stripped as any)._temp, undefined, '_temp should be stripped');
    assertEqual((stripped as any)._source, undefined, '_source should be stripped');
    assertEqual(stripped.docType, 'pdf', 'docType should survive');
    assertNotNull(stripped.selector, 'selector should survive');
  });

  await test('addAnnotation \u5185\u90E8\u8C03\u7528 stripExtraFields \u540E selector \u4ECD\u5728', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    const pdf = makePdfAnn({ uuid: 'pdf-strip3' });
    (pdf as any)._dirty = true;  // 临时标记

    await s.addAnnotation(pdf);
    const found = s.getAnnotationByUuid('pdf-strip3');
    assertNotNull(found);
    assertEqual((found as any)._dirty, undefined, '_dirty should be stripped during addAnnotation');
    assertEqual(found.docType, 'pdf');
    assertNotNull(found.selector);
    const sel = found.selector as PDFSelector;
    assertEqual(sel.rects.length, 1);
  });

  // ═══════════════════════════════════════════════════════
  // 7. PDF 标注 W3C 序列化往返无损
  // ═══════════════════════════════════════════════════════

  console.log('\u2500\u2500 7. PDF W3C \u5E8F\u5217\u5316\u5F80\u8FD4\u65E0\u635F \u2500\u2500');

  await test('PDF \u6807\u6CE8 serialize \u2192 deserialize \u2192 docType \u4FDD\u7559', () => {
    const pdf = makePdfAnn({ uuid: 'pdf-w3c-1', note: 'W3C test', tags: ['physics'] });
    const w3c = serializeAnnotation(pdf);

    // 确认 W3C 扩展字段存在
    assertEqual(w3c['markvault:docType'], 'pdf', 'markvault:docType should be set');

    const restored = deserializeAnnotation(w3c);
    assertEqual(restored.docType, 'pdf', 'docType should survive roundtrip');
  });

  await test('PDF \u6807\u6CE8 serialize \u2192 deserialize \u2192 selector \u4FDD\u7559', () => {
    const pdf = makePdfAnn({ uuid: 'pdf-w3c-2' });
    const w3c = serializeAnnotation(pdf);

    // 确认 selector 扩展字段存在
    const selExt = w3c['markvault:selector'];
    assertNotNull(selExt, 'markvault:selector should be set');

    const restored = deserializeAnnotation(w3c);
    assertNotNull(restored.selector, 'selector should survive roundtrip');
    const sel = restored.selector as PDFSelector;
    assertEqual(sel.type, 'pdf');
    assertEqual(sel.page, 0);
    assertEqual(sel.rects.length, 1);
    assertEqual(sel.rects[0].x1, 100);
    assertEqual(sel.rects[0].y2, 220);
    assertEqual(sel.textHash, 'abc123');
  });

  await test('PDF \u6807\u6CE8 W3C \u5F80\u8FD4 \u2192 tags/note \u4FDD\u7559', () => {
    const pdf = makePdfAnn({
      uuid: 'pdf-w3c-3',
      note: 'Important finding',
      tags: ['physics', 'quantum'],
    });
    const w3c = serializeAnnotation(pdf);
    const restored = deserializeAnnotation(w3c);

    assertEqual(restored.note, 'Important finding');
    assertEqual(restored.tags.length, 2);
    assertEqual(restored.tags[0], 'physics');
    assertEqual(restored.tags[1], 'quantum');
  });

  await test('PDF \u6807\u6CE8 W3C \u5F80\u8FD4 \u2192 flags/motivation \u4FDD\u7559', () => {
    const pdf = makePdfAnn({
      uuid: 'pdf-w3c-4',
      motivation: 'questioning',
      flags: {
        mastery: 'learning',
        confidence: 3,
        reviewPriority: 'high',
        needsCorrection: true,
      },
    });
    const w3c = serializeAnnotation(pdf);
    const restored = deserializeAnnotation(w3c);

    assertEqual(restored.motivation, 'questioning');
    assertNotNull(restored.flags);
    assertEqual(restored.flags!.mastery, 'learning');
    assertEqual(restored.flags!.confidence, 3);
    assertEqual(restored.flags!.reviewPriority, 'high');
    assertEqual(restored.flags!.needsCorrection, true);
  });

  // ═══════════════════════════════════════════════════════
  // 7b. percentRects 百分比坐标测试
  // ═══════════════════════════════════════════════════════

  console.log('\u2500\u2500 7b. percentRects \u767E\u5206\u6BD4\u5750\u6807 \u2500\u2500');

  await test('PDF \u6807\u6CE8 W3C \u5F80\u8FD4 \u2192 percentRects \u4FDD\u7559', () => {
    const pdf = makePdfAnn({ uuid: 'pdf-pr-1' });
    const w3c = serializeAnnotation(pdf);
    const restored = deserializeAnnotation(w3c);

    const sel = restored.selector as PDFSelector;
    assertNotNull(sel.percentRects, 'percentRects should survive roundtrip');
    assertEqual(sel.percentRects!.length, 1);
    assertEqual(sel.percentRects![0].x, 10);
    assertEqual(sel.percentRects![0].y, 20);
    assertEqual(sel.percentRects![0].width, 30);
    assertEqual(sel.percentRects![0].height, 5);
  });

  await test('percentRects \u53EF\u4E3A\u7A7A (\u65E7\u6570\u636E\u517C\u5BB9)', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    // 手动构造一个没有 percentRects 的旧标注
    const oldPdf = makePdfAnn({ uuid: 'pdf-old-1' });
    delete (oldPdf.selector as PDFSelector).percentRects;
    await s.addAnnotation(oldPdf);

    const found = s.getAnnotationByUuid('pdf-old-1');
    assertNotNull(found);
    const sel = found.selector as PDFSelector;
    assertEqual(sel.percentRects, undefined, 'old data should have no percentRects');
    assertEqual(sel.rects.length, 1, 'absolute rects should still exist');
  });

  await test('update percentRects \u2192 \u65B0\u503C\u53CD\u6620', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    await s.addAnnotation(makePdfAnn({ uuid: 'pdf-pr-2' }));

    const newSelector: PDFSelector = {
      type: 'pdf',
      page: 0,
      rects: [{ x1: 50, y1: 100, x2: 150, y2: 120 }],
      percentRects: [{ x: 5, y: 10, width: 15, height: 3 }],
    };
    await s.updateAnnotation('pdf-pr-2', { selector: newSelector });

    const found = s.getAnnotationByUuid('pdf-pr-2');
    assertNotNull(found);
    const sel = found.selector as PDFSelector;
    assertNotNull(sel.percentRects);
    assertEqual(sel.percentRects![0].x, 5, 'percentRects x should be updated');
    assertEqual(sel.percentRects![0].width, 15, 'percentRects width should be updated');
  });

  // ═══════════════════════════════════════════════════════
  // 8. getAnnotationsForFile 对 PDF 标注按 createdAt 排序
  // ═══════════════════════════════════════════════════════

  console.log('\u2500\u2500 8. getAnnotationsForFile \u6392\u5E8F\u9A8C\u8BC1 \u2500\u2500');

  await test('PDF \u6807\u6CE8\u6309 createdAt \u5347\u5E8F\u6392\u5217', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    const baseTime = Date.now();

    await s.addAnnotation(makePdfAnn({
      uuid: 'pdf-s3',
      filePath: 'books/sort.pdf',
      createdAt: baseTime + 3000,
    }));
    await s.addAnnotation(makePdfAnn({
      uuid: 'pdf-s1',
      filePath: 'books/sort.pdf',
      createdAt: baseTime + 1000,
    }));
    await s.addAnnotation(makePdfAnn({
      uuid: 'pdf-s2',
      filePath: 'books/sort.pdf',
      createdAt: baseTime + 2000,
    }));

    const list = s.getAnnotationsForFile('books/sort.pdf');
    assertEqual(list.length, 3);
    assertEqual(list[0].uuid, 'pdf-s1', 'first should be oldest');
    assertEqual(list[1].uuid, 'pdf-s2', 'second should be middle');
    assertEqual(list[2].uuid, 'pdf-s3', 'third should be newest');
  });

  await test('PDF + Markdown \u6DF7\u5408\u6392\u5E8F\u4E5F\u6309 createdAt \u5347\u5E8F', async () => {
    const s = new AnnotationStore(); s.init(createMockVault() as any); await s.initialize();
    const baseTime = Date.now();

    await s.addAnnotation(makePdfAnn({
      uuid: 'mix-s2',
      filePath: 'mixed/sort.pdf',
      createdAt: baseTime + 2000,
    }));
    await s.addAnnotation(makeMdAnn({
      uuid: 'mix-s1',
      filePath: 'mixed/sort.pdf',
      createdAt: baseTime + 1000,
    }));
    await s.addAnnotation(makePdfAnn({
      uuid: 'mix-s3',
      filePath: 'mixed/sort.pdf',
      createdAt: baseTime + 3000,
    }));

    const list = s.getAnnotationsForFile('mixed/sort.pdf');
    assertEqual(list.length, 3);
    assertEqual(list[0].uuid, 'mix-s1');
    assertEqual(list[1].uuid, 'mix-s2');
    assertEqual(list[2].uuid, 'mix-s3');
  });

  // ═══════════════════════════════════════════════════════
  // 结果
  // ═══════════════════════════════════════════════════════

  console.log(`\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
  console.log(`\u603B\u8BA1: ${passed + failed} | \u901A\u8FC7: ${passed} | \u5931\u8D25: ${failed}`);
  console.log(`\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
