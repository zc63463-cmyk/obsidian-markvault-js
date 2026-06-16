/**
 * Phase 3: W3C Web Annotation 序列化器测试
 *
 * 测试覆盖：
 * 1. W3C 结构验证（@context, id, type）
 * 2. 字段映射正确性（body, target, motivation）
 * 3. Selector 正确性（TextQuoteSelector, TextPositionSelector, RangeSelector）
 * 4. 自定义扩展字段（markvault:*）
 * 5. 关系序列化/反序列化
 * 6. 往返测试（MarkVault → W3C → MarkVault 数据无损）
 * 7. 边缘情况（空字段、缺失字段、复杂标注）
 * 8. Collection/分页导出
 * 9. 过滤功能
 */

import {
  serializeAnnotation,
  deserializeAnnotation,
  serializeCollection,
  filterAnnotationsForExport,
} from '../src/export/w3c-serializer';
import type { Annotation, AnnotationMotivation } from '../src/types/annotation';
import type { W3CAnnotation, W3CBody, W3CTextQuoteSelector, W3CTextPositionSelector, W3CRangeSelector } from '../src/export/w3c-types';

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
  if (actual !== expected) {
    throw new Error(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual: any, expected: any, label = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${label} expected ${b}, got ${a}`);
  }
}

// ── Mock 辅助函数 ──────────────────────────

function makeAnn(overrides: Partial<Annotation> & { uuid: string }): Annotation {
  return {
    uuid: overrides.uuid,
    text: overrides.text ?? `Annotation ${overrides.uuid}`,
    filePath: overrides.filePath ?? 'test.md',
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 1,
    kind: overrides.kind ?? 'inline',
    type: overrides.type ?? 'highlight',
    color: overrides.color ?? 'yellow',
    note: overrides.note ?? '',
    tags: overrides.tags ?? [],
    fields: overrides.fields ?? undefined,
    relations: overrides.relations ?? undefined,
    groups: overrides.groups ?? undefined,
    flags: overrides.flags ?? undefined,
    motivation: overrides.motivation,
    format: overrides.format,
    schemaVersion: overrides.schemaVersion ?? 2,
    startOffset: overrides.startOffset ?? 0,
    endOffset: overrides.endOffset ?? 10,
    contextBefore: overrides.contextBefore ?? '',
    contextAfter: overrides.contextAfter ?? '',
    createdAt: overrides.createdAt ?? 1700000000000,
    updatedAt: overrides.updatedAt ?? 1700000000000,
    // v2.0: 拆分标注 & 块级标注
    groupUuid: overrides.groupUuid ?? undefined,
    blockType: overrides.blockType ?? undefined,
    targetLine: overrides.targetLine ?? undefined,
    anchorLine: overrides.anchorLine ?? undefined,
    // v2.1: Span 标注
    spanRanges: overrides.spanRanges ?? undefined,
    // v2.2: 目标内容指纹
    targetHash: overrides.targetHash ?? undefined,
  };
}

// ═══════════════════════════════════════════════════════
// 1. W3C 结构验证
// ═══════════════════════════════════════════════════════

async function testW3CStructure() {
  await test('has @context', () => {
    const ann = makeAnn({ uuid: 'test-001', text: 'hello world' });
    const w3c = serializeAnnotation(ann);
    assertEqual(w3c['@context'], 'http://www.w3.org/ns/anno.jsonld');
  });

  await test('has id with prefix', () => {
    const ann = makeAnn({ uuid: 'test-001' });
    const w3c = serializeAnnotation(ann);
    assertEqual(w3c.id, 'markvault:test-001');
  });

  await test('has type Annotation', () => {
    const ann = makeAnn({ uuid: 'test-001' });
    const w3c = serializeAnnotation(ann);
    assertEqual(w3c.type, 'Annotation');
  });

  await test('has created/modified timestamps in ISO 8601', () => {
    const ann = makeAnn({ uuid: 'test-001', createdAt: 1700000000000, updatedAt: 1700000001000 });
    const w3c = serializeAnnotation(ann);
    assert(w3c.created!.endsWith('Z'), 'created should be ISO 8601');
    assert(w3c.modified!.endsWith('Z'), 'modified should be ISO 8601');
    assertEqual(w3c.created, '2023-11-14T22:13:20.000Z');
  });

  await test('custom id prefix', () => {
    const ann = makeAnn({ uuid: 'test-001' });
    const w3c = serializeAnnotation(ann, 'myapp');
    assertEqual(w3c.id, 'myapp:test-001');
  });

  await test('has generator agent', () => {
    const ann = makeAnn({ uuid: 'test-001' });
    const w3c = serializeAnnotation(ann);
    assert(w3c.generator !== undefined, 'should have generator');
    assertEqual(w3c.generator.type, 'Software');
    assert(w3c.generator.name.includes('MarkVault'), 'generator name should include MarkVault');
  });
}

// ═══════════════════════════════════════════════════════
// 2. Body 字段映射
// ═══════════════════════════════════════════════════════

async function testBodyMapping() {
  await test('note → body TextualBody (commenting)', () => {
    const ann = makeAnn({ uuid: 'test-001', note: 'This is important' });
    const w3c = serializeAnnotation(ann);
    assert(Array.isArray(w3c.body), 'body should be an array');
    const bodies = w3c.body as W3CBody[];
    const noteBody = bodies.find(b => b.purpose === 'commenting');
    assert(noteBody !== undefined, 'should have commenting body');
    assertEqual(noteBody.value, 'This is important');
    assertEqual(noteBody.type, 'TextualBody');
  });

  await test('no note → no commenting body', () => {
    const ann = makeAnn({ uuid: 'test-001', note: '' });
    const w3c = serializeAnnotation(ann);
    // When note is empty, body may be undefined or only contain tags
    if (w3c.body) {
      const bodies = Array.isArray(w3c.body) ? w3c.body : [w3c.body];
      const hasComment = bodies.some(b => b.purpose === 'commenting');
      assert(!hasComment, 'should not have commenting body when note is empty');
    }
  });

  await test('tags → body TextualBody (tagging)', () => {
    const ann = makeAnn({ uuid: 'test-001', tags: ['physics', 'important'] });
    const w3c = serializeAnnotation(ann);
    const bodies = w3c.body as W3CBody[];
    const tagBodies = bodies.filter(b => b.purpose === 'tagging');
    assertEqual(tagBodies.length, 2);
    assertEqual(tagBodies[0].value, 'physics');
    assertEqual(tagBodies[1].value, 'important');
  });

  await test('both note and tags → multiple bodies', () => {
    const ann = makeAnn({ uuid: 'test-001', note: 'Key theorem', tags: ['math'] });
    const w3c = serializeAnnotation(ann);
    const bodies = w3c.body as W3CBody[];
    assert(bodies.length >= 2, `expected at least 2 bodies, got ${bodies.length}`);
  });
}

// ═══════════════════════════════════════════════════════
// 3. Target & Selector 正确性
// ═══════════════════════════════════════════════════════

async function testTargetSelectors() {
  await test('target has source (filePath)', () => {
    const ann = makeAnn({ uuid: 'test-001', filePath: 'notes/physics.md' });
    const w3c = serializeAnnotation(ann);
    const target = w3c.target as any;
    assertEqual(target.source, 'notes/physics.md');
  });

  await test('TextQuoteSelector with exact/prefix/suffix', () => {
    const ann = makeAnn({
      uuid: 'test-001',
      text: 'E = mc²',
      contextBefore: 'Einstein showed that ',
      contextAfter: ' is the mass-energy equivalence.',
    });
    const w3c = serializeAnnotation(ann);
    const target = w3c.target as any;
    const selectors = target.selector as any[];
    const quoteSel = selectors.find((s: any) => s.type === 'TextQuoteSelector') as W3CTextQuoteSelector;
    assert(quoteSel !== undefined, 'should have TextQuoteSelector');
    assertEqual(quoteSel.exact, 'E = mc²');
    assertEqual(quoteSel.prefix, 'Einstein showed that ');
    assertEqual(quoteSel.suffix, ' is the mass-energy equivalence.');
  });

  await test('TextQuoteSelector without context omits prefix/suffix', () => {
    const ann = makeAnn({ uuid: 'test-001', text: 'simple text' });
    const w3c = serializeAnnotation(ann);
    const target = w3c.target as any;
    const selectors = target.selector as any[];
    const quoteSel = selectors.find((s: any) => s.type === 'TextQuoteSelector') as W3CTextQuoteSelector;
    assert(quoteSel.prefix === undefined || quoteSel.prefix === '', 'prefix should be empty/omitted');
    assert(quoteSel.suffix === undefined || quoteSel.suffix === '', 'suffix should be empty/omitted');
  });

  await test('TextPositionSelector with offsets', () => {
    const ann = makeAnn({ uuid: 'test-001', startOffset: 42, endOffset: 99 });
    const w3c = serializeAnnotation(ann);
    const target = w3c.target as any;
    const selectors = target.selector as any[];
    const posSel = selectors.find((s: any) => s.type === 'TextPositionSelector') as W3CTextPositionSelector;
    assert(posSel !== undefined, 'should have TextPositionSelector');
    assertEqual(posSel.start, 42);
    assertEqual(posSel.end, 99);
  });

  await test('Region annotation uses RangeSelector', () => {
    const ann = makeAnn({
      uuid: 'test-001',
      kind: 'region',
      startOffset: 100,
      endOffset: 500,
      endLine: 25,
    });
    const w3c = serializeAnnotation(ann);
    const target = w3c.target as any;
    const selectors = target.selector as any[];
    const rangeSel = selectors.find((s: any) => s.type === 'RangeSelector') as W3CRangeSelector;
    assert(rangeSel !== undefined, 'should have RangeSelector for region');
    assertEqual(rangeSel.startSelector.start, 100);
    assertEqual(rangeSel.endSelector.end, 500);
  });

  await test('block annotation uses TextPositionSelector (not RangeSelector)', () => {
    const ann = makeAnn({
      uuid: 'test-001',
      kind: 'block',
      startOffset: 10,
      endOffset: 50,
    });
    const w3c = serializeAnnotation(ann);
    const target = w3c.target as any;
    const selectors = target.selector as any[];
    const rangeSel = selectors.find((s: any) => s.type === 'RangeSelector');
    assert(rangeSel === undefined, 'block should not use RangeSelector');
    const posSel = selectors.find((s: any) => s.type === 'TextPositionSelector');
    assert(posSel !== undefined, 'block should have TextPositionSelector');
  });
}

// ═══════════════════════════════════════════════════════
// 4. Motivation 映射
// ═══════════════════════════════════════════════════════

async function testMotivationMapping() {
  const motivations: AnnotationMotivation[] = [
    'commenting', 'highlighting', 'questioning', 'editing',
    'bookmarking', 'replying', 'classifying',
  ];

  for (const mot of motivations) {
    await test(`motivation ${mot} serializes correctly`, () => {
      const ann = makeAnn({ uuid: 'test-001', motivation: mot });
      const w3c = serializeAnnotation(ann);
      assertEqual(w3c.motivation, mot);
    });
  }

  await test('no motivation → undefined in W3C', () => {
    const ann = makeAnn({ uuid: 'test-001' });
    const w3c = serializeAnnotation(ann);
    assert(w3c.motivation === undefined, 'should not have motivation when not set');
  });
}

// ═══════════════════════════════════════════════════════
// 5. 自定义扩展字段
// ═══════════════════════════════════════════════════════

async function testCustomExtensions() {
  await test('markvault:type, :color, :kind', () => {
    const ann = makeAnn({ uuid: 'test-001', type: 'underline', color: '#FF0000', kind: 'block' });
    const w3c = serializeAnnotation(ann);
    assertEqual(w3c['markvault:type'], 'underline');
    assertEqual(w3c['markvault:color'], '#FF0000');
    assertEqual(w3c['markvault:kind'], 'block');
  });

  await test('markvault:fields serialized', () => {
    const ann = makeAnn({
      uuid: 'test-001',
      fields: { 'category': '定义', 'importance': '高' },
    });
    const w3c = serializeAnnotation(ann);
    assertDeepEqual(w3c['markvault:fields'], { 'category': '定义', 'importance': '高' });
  });

  await test('markvault:groups serialized', () => {
    const ann = makeAnn({ uuid: 'test-001', groups: ['ch12', 'key_theorems'] });
    const w3c = serializeAnnotation(ann);
    assertDeepEqual(w3c['markvault:groups'], ['ch12', 'key_theorems']);
  });

  await test('markvault:tags duplicated for W3C body tagging + custom', () => {
    const ann = makeAnn({ uuid: 'test-001', tags: ['physics', 'math'] });
    const w3c = serializeAnnotation(ann);
    // tags should appear in both: body (as W3C standard) and markvault:tags (for round-trip fidelity)
    assertDeepEqual(w3c['markvault:tags'], ['physics', 'math']);
  });

  await test('markvault:format preserved', () => {
    const ann = makeAnn({ uuid: 'test-001', format: 'native' });
    const w3c = serializeAnnotation(ann);
    assertEqual(w3c['markvault:format'], 'native');
  });

  await test('markvault:schemaVersion preserved', () => {
    const ann = makeAnn({ uuid: 'test-001', schemaVersion: 2 });
    const w3c = serializeAnnotation(ann);
    assertEqual(w3c['markvault:schemaVersion'], 2);
  });
}

// ═══════════════════════════════════════════════════════
// 6. 关系序列化
// ═══════════════════════════════════════════════════════

async function testRelationSerialization() {
  await test('relations → markvault:relations', () => {
    const ann = makeAnn({
      uuid: 'test-001',
      relations: [
        {
          targetUuid: 'test-002',
          type: 'applies',
          createdAt: 1700000000000,
          source: 'manual' as const,
        },
      ],
    });
    const w3c = serializeAnnotation(ann);
    const rels = w3c['markvault:relations'];
    assert(rels !== undefined, 'should have markvault:relations');
    assertEqual(rels!.length, 1);
    assertEqual(rels![0].targetUuid, 'test-002');
    assertEqual(rels![0].type, 'applies');
    assertEqual(rels![0].source, 'manual');
    assertEqual(rels![0].createdAt, '2023-11-14T22:13:20.000Z');
  });

  await test('relation with note', () => {
    const ann = makeAnn({
      uuid: 'test-001',
      relations: [{
        targetUuid: 'test-002',
        type: 'references',
        createdAt: 1700000000000,
        note: 'See also',
      }],
    });
    const w3c = serializeAnnotation(ann);
    const rels = w3c['markvault:relations'];
    assertEqual(rels![0].note, 'See also');
  });

  await test('invalidated relation preserves invalidAt', () => {
    const ann = makeAnn({
      uuid: 'test-001',
      relations: [{
        targetUuid: 'test-002',
        type: 'applies',
        createdAt: 1700000000000,
        invalidAt: 1700000001000,
      }],
    });
    const w3c = serializeAnnotation(ann);
    const rels = w3c['markvault:relations'];
    assertEqual(rels![0].invalidAt, '2023-11-14T22:13:21.000Z');
  });

  await test('no relations → no markvault:relations', () => {
    const ann = makeAnn({ uuid: 'test-001' });
    const w3c = serializeAnnotation(ann);
    assert(w3c['markvault:relations'] === undefined, 'should not have relations when none exist');
  });
}

// ═══════════════════════════════════════════════════════
// 7. Flags 序列化
// ═══════════════════════════════════════════════════════

async function testFlagsSerialization() {
  await test('full flags serialized', () => {
    const ann = makeAnn({
      uuid: 'test-001',
      flags: {
        mastery: 'mastered',
        reviewPriority: 'high',
        confidence: 4,
        needsCorrection: false,
        lastReviewedAt: 1700000000000,
        reviewCount: 3,
      },
    });
    const w3c = serializeAnnotation(ann);
    const flags = w3c['markvault:flags'];
    assert(flags !== undefined, 'should have markvault:flags');
    assertEqual(flags!.mastery, 'mastered');
    assertEqual(flags!.reviewPriority, 'high');
    assertEqual(flags!.confidence, 4);
    assertEqual(flags!.needsCorrection, false);
    assertEqual(flags!.reviewCount, 3);
    assertEqual(flags!.lastReviewedAt, '2023-11-14T22:13:20.000Z');
  });

  await test('empty flags → no markvault:flags', () => {
    const ann = makeAnn({ uuid: 'test-001', flags: {} });
    const w3c = serializeAnnotation(ann);
    assert(w3c['markvault:flags'] === undefined, 'should not have flags when empty');
  });

  await test('partial flags (needsCorrection only)', () => {
    const ann = makeAnn({
      uuid: 'test-001',
      flags: { needsCorrection: true },
    });
    const w3c = serializeAnnotation(ann);
    assertEqual(w3c['markvault:flags']!.needsCorrection, true);
  });
}

// ═══════════════════════════════════════════════════════
// 8. 往返测试（MarkVault → W3C → MarkVault）
// ═══════════════════════════════════════════════════════

async function testRoundTrip() {
  await test('basic round-trip: inline highlight', () => {
    const original = makeAnn({
      uuid: 'rt-001',
      text: 'quantum entanglement',
      filePath: 'notes/physics.md',
      type: 'highlight',
      color: 'yellow',
      note: 'Key concept for QM',
      tags: ['physics', 'quantum'],
      startOffset: 150,
      endOffset: 172,
      contextBefore: 'The phenomenon of ',
      contextAfter: ' is fundamental.',
      motivation: 'commenting',
      kind: 'inline',
    });

    const w3c = serializeAnnotation(original);
    const roundTripped = deserializeAnnotation(w3c, original.filePath);

    assertEqual(roundTripped.uuid, original.uuid, 'uuid');
    assertEqual(roundTripped.filePath, original.filePath, 'filePath');
    assertEqual(roundTripped.text, original.text, 'text');
    assertEqual(roundTripped.note, original.note, 'note');
    assertDeepEqual(roundTripped.tags, original.tags, 'tags');
    assertEqual(roundTripped.type, original.type, 'type');
    assertEqual(roundTripped.color, original.color, 'color');
    assertEqual(roundTripped.motivation, original.motivation, 'motivation');
    assertEqual(roundTripped.kind, original.kind, 'kind');
    assertEqual(roundTripped.startOffset, original.startOffset, 'startOffset');
    assertEqual(roundTripped.endOffset, original.endOffset, 'endOffset');
    assertEqual(roundTripped.contextBefore, original.contextBefore, 'contextBefore');
    assertEqual(roundTripped.contextAfter, original.contextAfter, 'contextAfter');
  });

  await test('round-trip: region annotation with endLine', () => {
    const original = makeAnn({
      uuid: 'rt-002',
      kind: 'region',
      startOffset: 100,
      endOffset: 500,
      endLine: 25,
      text: 'multi-line content spanning several paragraphs',
    });

    const w3c = serializeAnnotation(original);
    const roundTripped = deserializeAnnotation(w3c, original.filePath);

    assertEqual(roundTripped.kind, 'region', 'kind');
    assertEqual(roundTripped.startOffset, 100, 'startOffset');
    assertEqual(roundTripped.endOffset, 500, 'endOffset');
  });

  await test('round-trip: relations preserved', () => {
    const original = makeAnn({
      uuid: 'rt-003',
      relations: [
        {
          targetUuid: 'target-001',
          type: 'applies',
          createdAt: 1700000000000,
          note: 'This theorem applies here',
          source: 'manual' as const,
        },
        {
          targetUuid: 'target-002',
          type: 'references',
          createdAt: 1700000000000,
          source: 'inferred' as const,
        },
      ],
    });

    const w3c = serializeAnnotation(original);
    const roundTripped = deserializeAnnotation(w3c, original.filePath);

    const rels = roundTripped.relations!;
    assertEqual(rels.length, 2, 'relations count');
    assertEqual(rels[0].targetUuid, 'target-001');
    assertEqual(rels[0].type, 'applies');
    assertEqual(rels[0].note, 'This theorem applies here');
    assertEqual(rels[0].source, 'manual');
    assertEqual(rels[1].targetUuid, 'target-002');
    assertEqual(rels[1].type, 'references');
    assertEqual(rels[1].source, 'inferred');
  });

  await test('round-trip: flags preserved', () => {
    const original = makeAnn({
      uuid: 'rt-004',
      flags: {
        mastery: 'learning',
        reviewPriority: 'medium',
        confidence: 3,
        needsCorrection: true,
        reviewCount: 5,
      },
    });

    const w3c = serializeAnnotation(original);
    const roundTripped = deserializeAnnotation(w3c, original.filePath);

    assertEqual(roundTripped.flags!.mastery, 'learning');
    assertEqual(roundTripped.flags!.reviewPriority, 'medium');
    assertEqual(roundTripped.flags!.confidence, 3);
    assertEqual(roundTripped.flags!.needsCorrection, true);
    assertEqual(roundTripped.flags!.reviewCount, 5);
  });

  await test('round-trip: fields preserved', () => {
    const original = makeAnn({
      uuid: 'rt-005',
      fields: { 'category': '定理', 'importance': '高', 'understanding': '部分理解' },
    });

    const w3c = serializeAnnotation(original);
    const roundTripped = deserializeAnnotation(w3c, original.filePath);

    assertDeepEqual(roundTripped.fields, original.fields, 'fields');
  });

  await test('round-trip: groups preserved', () => {
    const original = makeAnn({
      uuid: 'rt-006',
      groups: ['ch12', 'exam_topics', 'key_theorems'],
    });

    const w3c = serializeAnnotation(original);
    const roundTripped = deserializeAnnotation(w3c, original.filePath);

    assertDeepEqual(roundTripped.groups, original.groups, 'groups');
  });

  await test('round-trip: full annotation with all fields', () => {
    const original = makeAnn({
      uuid: 'rt-full',
      text: 'Hψ = Eψ',
      filePath: 'qm-notes.md',
      type: 'highlight',
      color: '#4ADE80',
      note: 'Schrödinger equation — time independent form',
      tags: ['quantum', 'equation', 'fundamental'],
      startOffset: 200,
      endOffset: 208,
      startLine: 12,
      endLine: 12,
      contextBefore: 'The time-independent ',
      contextAfter: ' describes stationary states.',
      motivation: 'commenting',
      kind: 'inline',
      format: 'native',
      schemaVersion: 2,
      fields: { 'category': '方程', 'domain': '量子力学' },
      groups: ['ch3', 'fundamental_equations'],
      relations: [{
        targetUuid: 'rel-001',
        type: 'proves',
        createdAt: 1700000000000,
        note: 'Proves energy quantization',
        source: 'manual' as const,
      }],
      flags: {
        mastery: 'familiar',
        reviewPriority: 'high',
        confidence: 4,
        needsCorrection: false,
        lastReviewedAt: 1700000000000,
        reviewCount: 7,
      },
    });

    const w3c = serializeAnnotation(original);
    const roundTripped = deserializeAnnotation(w3c, original.filePath);

    // Verify all core fields
    assertEqual(roundTripped.uuid, original.uuid);
    assertEqual(roundTripped.text, original.text);
    assertEqual(roundTripped.note, original.note);
    assertEqual(roundTripped.type, original.type);
    assertEqual(roundTripped.color, original.color);
    assertEqual(roundTripped.motivation, original.motivation);
    assertEqual(roundTripped.kind, original.kind);
    assertEqual(roundTripped.format, original.format);
    assertEqual(roundTripped.schemaVersion, original.schemaVersion);
    assertEqual(roundTripped.startOffset, original.startOffset);
    assertEqual(roundTripped.endOffset, original.endOffset);
    assertEqual(roundTripped.startLine, original.startLine, 'startLine round-trip');
    assertEqual(roundTripped.endLine, original.endLine, 'endLine round-trip');
    assertEqual(roundTripped.contextBefore, original.contextBefore);
    assertEqual(roundTripped.contextAfter, original.contextAfter);

    // Complex types
    assertDeepEqual(roundTripped.tags, original.tags);
    assertDeepEqual(roundTripped.fields, original.fields);
    assertDeepEqual(roundTripped.groups, original.groups);

    // Relations
    assert(roundTripped.relations !== undefined);
    assertEqual(roundTripped.relations!.length, 1);
    assertEqual(roundTripped.relations![0].targetUuid, 'rel-001');
    assertEqual(roundTripped.relations![0].type, 'proves');
    assertEqual(roundTripped.relations![0].note, 'Proves energy quantization');

    // Flags
    assert(roundTripped.flags !== undefined);
    assertEqual(roundTripped.flags!.mastery, 'familiar');
    assertEqual(roundTripped.flags!.confidence, 4);
    assertEqual(roundTripped.flags!.reviewCount, 7);
    assertEqual(roundTripped.flags!.needsCorrection, false, 'needsCorrection:false must survive round-trip');
  });
}

// ═══════════════════════════════════════════════════════
// 9. Collection 导出
// ═══════════════════════════════════════════════════════

async function testCollectionExport() {
  await test('collection with @context including LDP', () => {
    const anns = [
      makeAnn({ uuid: 'c-001' }),
      makeAnn({ uuid: 'c-002' }),
    ];
    const collection = serializeCollection(anns);
    assert(collection['@context'].includes('http://www.w3.org/ns/ldp.jsonld'), 'should include LDP context');
    assertEqual(collection.type, 'AnnotationCollection');
    assertEqual(collection.total, 2);
  });

  await test('collection items contain serialized annotations', () => {
    const anns = [makeAnn({ uuid: 'c-001', text: 'hello' })];
    const collection = serializeCollection(anns);
    assert(collection.items !== undefined, 'should have items');
    assertEqual(collection.items!.length, 1);
    assertEqual(collection.items![0].id, 'markvault:c-001');
  });

  await test('collection with label', () => {
    const anns = [makeAnn({ uuid: 'c-001' })];
    const collection = serializeCollection(anns, { label: 'Physics Notes' });
    assertEqual(collection.label, 'Physics Notes');
  });

  await test('collection pagination (pageSize=1 for 2 items)', () => {
    const anns = [
      makeAnn({ uuid: 'c-001' }),
      makeAnn({ uuid: 'c-002' }),
    ];
    const collection = serializeCollection(anns, { pageSize: 1 });

    // Should have first page, not inline items
    assert(collection.first !== undefined, 'should have first page');
    assert(collection.items === undefined, 'should NOT have inline items when paginated');
    assertEqual(collection.first!.type, 'AnnotationPage');
    assertEqual(collection.first!.items.length, 1);
    assertEqual(collection.first!.startIndex, 0);
    assertEqual(collection.first!.partOf, 'markvault:collection');
  });

  await test('collection no pagination when pageSize=0', () => {
    const anns = [makeAnn({ uuid: 'c-001' })];
    const collection = serializeCollection(anns, { pageSize: 0 });
    assert(collection.items !== undefined, 'should have inline items');
    assert(collection.first === undefined, 'should NOT have first page');
  });

  await test('empty collection', () => {
    const collection = serializeCollection([]);
    assertEqual(collection.total, 0);
    assert(collection.items !== undefined);
    assertEqual(collection.items!.length, 0);
  });
}

// ═══════════════════════════════════════════════════════
// 10. 过滤功能
// ═══════════════════════════════════════════════════════

async function testFiltering() {
  const anns = [
    makeAnn({ uuid: 'f-001', filePath: 'physics.md', motivation: 'questioning' }),
    makeAnn({ uuid: 'f-002', filePath: 'physics.md', motivation: 'commenting' }),
    makeAnn({ uuid: 'f-003', filePath: 'math.md', motivation: 'highlighting' }),
    makeAnn({
      uuid: 'f-004',
      filePath: 'physics.md',
      motivation: 'commenting',
      relations: [{ targetUuid: 'other', type: 'applies', createdAt: 1700000000000 }],
    }),
  ];

  await test('filter by filePath', () => {
    const filtered = filterAnnotationsForExport(anns, { filePath: 'physics.md' });
    assertEqual(filtered.length, 3);
  });

  await test('filter by motivation', () => {
    const filtered = filterAnnotationsForExport(anns, { motivation: 'questioning' });
    assertEqual(filtered.length, 1);
    assertEqual(filtered[0].uuid, 'f-001');
  });

  await test('filter by motivation and filePath (combined)', () => {
    const filtered = filterAnnotationsForExport(anns, {
      filePath: 'physics.md',
      motivation: 'commenting',
    });
    assertEqual(filtered.length, 2);
  });

  await test('filter by kind', () => {
    const anns2 = [
      makeAnn({ uuid: 'k-001', kind: 'inline' }),
      makeAnn({ uuid: 'k-002', kind: 'block' }),
      makeAnn({ uuid: 'k-003', kind: 'region', endLine: 10, startOffset: 0, endOffset: 50 }),
    ];
    const filtered = filterAnnotationsForExport(anns2, { kind: 'block' });
    assertEqual(filtered.length, 1);
    assertEqual(filtered[0].uuid, 'k-002');
  });

  await test('filter by relationType', () => {
    const filtered = filterAnnotationsForExport(anns, { relationType: 'applies' });
    assertEqual(filtered.length, 1);
    assertEqual(filtered[0].uuid, 'f-004');
  });

  await test('no filter → all annotations', () => {
    const filtered = filterAnnotationsForExport(anns, {});
    assertEqual(filtered.length, 4);
  });
}

// ═══════════════════════════════════════════════════════
// 11. 边缘情况
// ═══════════════════════════════════════════════════════

async function testEdgeCases() {
  await test('minimal annotation (only required fields)', () => {
    const ann: Annotation = {
      uuid: 'minimal-001',
      filePath: 'test.md',
      type: 'highlight',
      color: 'yellow',
      text: '',
      note: '',
      tags: [],
      startOffset: 0,
      endOffset: 0,
      startLine: 0,
      contextBefore: '',
      contextAfter: '',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    };
    const w3c = serializeAnnotation(ann);
    assertEqual(w3c.id, 'markvault:minimal-001');
    assertEqual(w3c.type, 'Annotation');
    assert(w3c['@context'] !== undefined);
    // Should not throw
  });

  await test('annotation with empty text → no TextQuoteSelector', () => {
    const ann = makeAnn({ uuid: 'test-001', text: '' });
    const w3c = serializeAnnotation(ann);
    const target = w3c.target as any;
    const selectors = target.selector as any[];
    const quoteSel = selectors.find((s: any) => s.type === 'TextQuoteSelector');
    assert(quoteSel === undefined, 'should not have TextQuoteSelector for empty text');
  });

  await test('annotation with whitespace-only text', () => {
    const ann = makeAnn({ uuid: 'test-001', text: '   ' });
    const w3c = serializeAnnotation(ann);
    const target = w3c.target as any;
    const selectors = target.selector as any[];
    const quoteSel = selectors.find((s: any) => s.type === 'TextQuoteSelector');
    assert(quoteSel === undefined, 'should not have TextQuoteSelector for whitespace-only text');
  });

  await test('span annotation uses TextPositionSelector', () => {
    const ann = makeAnn({ uuid: 'test-001', kind: 'span', startOffset: 10, endOffset: 30 });
    const w3c = serializeAnnotation(ann);
    const target = w3c.target as any;
    const selectors = target.selector as any[];
    const posSel = selectors.find((s: any) => s.type === 'TextPositionSelector');
    assert(posSel !== undefined, 'span should have TextPositionSelector');
  });

  await test('block annotation with endLine → still uses TextPositionSelector', () => {
    const ann = makeAnn({
      uuid: 'test-001',
      kind: 'block',
      endLine: 10,
      startOffset: 50,
      endOffset: 100,
    });
    const w3c = serializeAnnotation(ann);
    const target = w3c.target as any;
    const selectors = target.selector as any[];
    // block != region, so no RangeSelector  
    const rangeSel = selectors.find((s: any) => s.type === 'RangeSelector');
    assert(rangeSel === undefined, 'block should not get RangeSelector');
  });

  await test('very long text (>1000 chars)', () => {
    const longText = 'A'.repeat(2000);
    const ann = makeAnn({ uuid: 'test-001', text: longText });
    const w3c = serializeAnnotation(ann);
    const target = w3c.target as any;
    const selectors = target.selector as any[];
    const quoteSel = selectors.find((s: any) => s.type === 'TextQuoteSelector') as W3CTextQuoteSelector;
    assertEqual(quoteSel.exact.length, 2000);
  });
}

// ═══════════════════════════════════════════════════════
// 12. Schema 合规性检查
// ═══════════════════════════════════════════════════════

async function testSchemaCompliance() {
  await test('W3C output has valid JSON structure', () => {
    const ann = makeAnn({ uuid: 'test-001', note: 'test note', tags: ['tag1'] });
    const w3c = serializeAnnotation(ann);
    const json = JSON.stringify(w3c);
    const parsed = JSON.parse(json);
    assertEqual(parsed['@context'], 'http://www.w3.org/ns/anno.jsonld');
    assertEqual(parsed.type, 'Annotation');
    assert(parsed.id !== undefined);
  });

  await test('W3C output is serializable (no circular refs)', () => {
    const ann = makeAnn({
      uuid: 'test-001',
      relations: [{ targetUuid: 'test-002', type: 'applies', createdAt: Date.now() }],
    });
    const w3c = serializeAnnotation(ann);
    // Should not throw circular reference error
    const json = JSON.stringify(w3c);
    assert(json.length > 0);
  });

  await test('all motivations map to valid W3C values', () => {
    const validW3CMotivations = [
      'assessing', 'bookmarking', 'classifying', 'commenting',
      'describing', 'editing', 'highlighting', 'identifying',
      'linking', 'moderating', 'questioning', 'replying', 'tagging',
    ];
    // replying is in the list above — verifying our motivations are all W3C-valid
    const markVaultMotivations: AnnotationMotivation[] = [
      'commenting', 'highlighting', 'questioning', 'editing',
      'bookmarking', 'replying', 'classifying',
    ];
    for (const mot of markVaultMotivations) {
      assert(validW3CMotivations.includes(mot), `${mot} is not a valid W3C motivation`);
    }
  });

  await test('selector types are valid (TextQuoteSelector/TextPositionSelector/RangeSelector)', () => {
    const validSelectorTypes = ['TextQuoteSelector', 'TextPositionSelector', 'RangeSelector', 'FragmentSelector'];

    // Test inline
    const inAnn = makeAnn({ uuid: 'test-001', kind: 'inline', text: 'hello', startOffset: 0, endOffset: 5 });
    const inW3c = serializeAnnotation(inAnn);
    const inSel = (inW3c.target as any).selector as any[];
    for (const s of inSel) {
      assert(validSelectorTypes.includes(s.type), `invalid selector type: ${s.type}`);
    }

    // Test region
    const regAnn = makeAnn({ uuid: 'test-002', kind: 'region', endLine: 10, startOffset: 0, endOffset: 50 });
    const regW3c = serializeAnnotation(regAnn);
    const regSel = (regW3c.target as any).selector as any[];
    for (const s of regSel) {
      assert(validSelectorTypes.includes(s.type), `invalid selector type: ${s.type}`);
    }
  });
}

// ═══════════════════════════════════════════════════════
// 13. 反序列化边缘情况
// ═══════════════════════════════════════════════════════

async function testDeserializationEdgeCases() {
  await test('deserialize from minimal W3C annotation', () => {
    const w3c: W3CAnnotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      id: 'minimal:id-only',
      type: 'Annotation',
    };
    const result = deserializeAnnotation(w3c, 'fallback.md');
    assertEqual(result.uuid, 'id-only', 'uuid extracted from id');
    assertEqual(result.filePath, 'fallback.md', 'filePath from fallback');
    assertEqual(result.type, 'highlight', 'default type');
    assertEqual(result.color, 'yellow', 'default color');
  });

  await test('deserialize extracts uuid after last colon', () => {
    const w3c: W3CAnnotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      id: 'prefix:nested:actual-uuid-123',
      type: 'Annotation',
    };
    const result = deserializeAnnotation(w3c);
    assertEqual(result.uuid, 'actual-uuid-123');
  });

  await test('deserialize body without purpose → note extraction', () => {
    const w3c: W3CAnnotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      id: 'test:uuid-1',
      type: 'Annotation',
      body: { type: 'TextualBody', value: 'Just a comment', format: 'text/plain' },
    };
    const result = deserializeAnnotation(w3c);
    assertEqual(result.note, 'Just a comment');
  });

  await test('deserialize tags from markvault:tags', () => {
    const w3c: W3CAnnotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      id: 'test:uuid-1',
      type: 'Annotation',
      'markvault:tags': ['physics', 'math'],
    };
    const result = deserializeAnnotation(w3c);
    assertDeepEqual(result.tags, ['physics', 'math']);
  });

  await test('deserialize tags from body tagging fallback', () => {
    const w3c: W3CAnnotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      id: 'test:uuid-1',
      type: 'Annotation',
      // No markvault:tags, but body has tagging bodies
      body: [
        { type: 'TextualBody', value: 'physics', purpose: 'tagging' },
        { type: 'TextualBody', value: 'math', purpose: 'tagging' },
      ],
    };
    const result = deserializeAnnotation(w3c);
    assertDeepEqual(result.tags, ['physics', 'math']);
  });
}

// ═══════════════════════════════════════════════════════
// 14. 审计修复：遗漏字段序列化/往返
// ═══════════════════════════════════════════════════════

async function testMissingFieldsAudit() {
  await test('groupUuid serialized and round-tripped', () => {
    const original = makeAnn({ uuid: 'audit-001', groupUuid: 'split-group-abc' });
    const w3c = serializeAnnotation(original);
    assertEqual(w3c['markvault:groupUuid'], 'split-group-abc');
    const roundTripped = deserializeAnnotation(w3c, original.filePath);
    assertEqual(roundTripped.groupUuid, 'split-group-abc');
  });

  await test('blockType serialized and round-tripped', () => {
    const original = makeAnn({ uuid: 'audit-002', kind: 'block', blockType: 'math-block' });
    const w3c = serializeAnnotation(original);
    assertEqual(w3c['markvault:blockType'], 'math-block');
    const roundTripped = deserializeAnnotation(w3c, original.filePath);
    assertEqual(roundTripped.blockType, 'math-block');
  });

  await test('targetLine serialized and round-tripped', () => {
    const original = makeAnn({ uuid: 'audit-003', kind: 'block', targetLine: 42 });
    const w3c = serializeAnnotation(original);
    assertEqual(w3c['markvault:targetLine'], 42);
    const roundTripped = deserializeAnnotation(w3c, original.filePath);
    assertEqual(roundTripped.targetLine, 42);
  });

  await test('anchorLine serialized and round-tripped', () => {
    const original = makeAnn({ uuid: 'audit-004', anchorLine: 15 });
    const w3c = serializeAnnotation(original);
    assertEqual(w3c['markvault:anchorLine'], 15);
    const roundTripped = deserializeAnnotation(w3c, original.filePath);
    assertEqual(roundTripped.anchorLine, 15);
  });

  await test('targetHash serialized and round-tripped', () => {
    const original = makeAnn({ uuid: 'audit-005', targetHash: 'sha256:abc123def' });
    const w3c = serializeAnnotation(original);
    assertEqual(w3c['markvault:targetHash'], 'sha256:abc123def');
    const roundTripped = deserializeAnnotation(w3c, original.filePath);
    assertEqual(roundTripped.targetHash, 'sha256:abc123def');
  });

  await test('spanRanges serialized and round-tripped', () => {
    const original = makeAnn({
      uuid: 'audit-006',
      kind: 'span',
      spanRanges: [{ from: 10, to: 25 }, { from: 50, to: 80 }],
    });
    const w3c = serializeAnnotation(original);
    assert(w3c['markvault:spanRanges'] !== undefined, 'should have spanRanges');
    assertEqual(w3c['markvault:spanRanges']!.length, 2);
    assertEqual(w3c['markvault:spanRanges']![0].from, 10);
    assertEqual(w3c['markvault:spanRanges']![1].to, 80);
    const roundTripped = deserializeAnnotation(w3c, original.filePath);
    assert(roundTripped.spanRanges !== undefined, 'round-trip should preserve spanRanges');
    assertEqual(roundTripped.spanRanges!.length, 2);
    assertEqual(roundTripped.spanRanges![0].from, 10);
    assertEqual(roundTripped.spanRanges![1].to, 80);
  });

  await test('startLine/endLine round-tripped via markvault: extensions', () => {
    const original = makeAnn({
      uuid: 'audit-007',
      startLine: 5,
      endLine: 12,
      kind: 'inline',
    });
    const w3c = serializeAnnotation(original);
    assertEqual(w3c['markvault:startLine'], 5);
    assertEqual(w3c['markvault:endLine'], 12);
    const roundTripped = deserializeAnnotation(w3c, original.filePath);
    assertEqual(roundTripped.startLine, 5, 'startLine should round-trip');
    assertEqual(roundTripped.endLine, 12, 'endLine should round-trip');
  });
}

// ═══════════════════════════════════════════════════════
// 15. 审计修复：falsy 值往返测试
// ═══════════════════════════════════════════════════════

async function testFalsyRoundTrip() {
  await test('needsCorrection: false round-trips correctly', () => {
    const original = makeAnn({
      uuid: 'falsy-001',
      flags: { needsCorrection: false },
    });
    const w3c = serializeAnnotation(original);
    assertEqual(w3c['markvault:flags']!.needsCorrection, false);
    const roundTripped = deserializeAnnotation(w3c, original.filePath);
    assertEqual(roundTripped.flags!.needsCorrection, false, 'needsCorrection=false must survive round-trip');
  });

  await test('reviewCount: 0 round-trips correctly', () => {
    const original = makeAnn({
      uuid: 'falsy-002',
      flags: { reviewCount: 0 },
    });
    const w3c = serializeAnnotation(original);
    // reviewCount: 0 is a valid value (never reviewed)
    const roundTripped = deserializeAnnotation(w3c, original.filePath);
    assertEqual(roundTripped.flags!.reviewCount, 0, 'reviewCount=0 must survive round-trip');
  });

  await test('invalid source value filtered during deserialization', () => {
    const w3c: W3CAnnotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      id: 'test:falsy-003',
      type: 'Annotation',
      'markvault:relations': [{
        targetUuid: 'other',
        type: 'applies',
        createdAt: '2023-11-14T22:13:20.000Z',
        source: 'hacked-invalid-value',
      }],
    };
    const result = deserializeAnnotation(w3c);
    // Invalid source should be filtered out, not passed through
    assert(result.relations !== undefined, 'should have relations');
    assertEqual(result.relations![0].source, undefined, 'invalid source should be filtered');
  });
}

// ═══════════════════════════════════════════════════════
// 16. 审计修复：RangeSelector 语义
// ═══════════════════════════════════════════════════════

async function testRangeSelectorSemantics() {
  await test('RangeSelector startSelector.end > startSelector.start', () => {
    const ann = makeAnn({
      uuid: 'range-001',
      kind: 'region',
      startOffset: 100,
      endOffset: 500,
      endLine: 25,
    });
    const w3c = serializeAnnotation(ann);
    const target = w3c.target as any;
    const selectors = target.selector as any[];
    const rangeSel = selectors.find((s: any) => s.type === 'RangeSelector') as W3CRangeSelector;
    assert(rangeSel !== undefined, 'should have RangeSelector');
    assert(rangeSel.startSelector.end > rangeSel.startSelector.start,
      'startSelector should not be zero-length');
    assert(rangeSel.endSelector.end > rangeSel.endSelector.start,
      'endSelector should not be zero-length');
  });
}

// ═══════════════════════════════════════════════════════
// 运行
// ═══════════════════════════════════════════════════════

async function runAll() {
  console.log('\n📦 Phase 3: W3C Web Annotation 序列化器测试');
  console.log('═'.repeat(55));

  console.log('\n1️⃣  W3C 结构验证');
  await testW3CStructure();

  console.log('\n2️⃣  Body 字段映射');
  await testBodyMapping();

  console.log('\n3️⃣  Target & Selector');
  await testTargetSelectors();

  console.log('\n4️⃣  Motivation 映射');
  await testMotivationMapping();

  console.log('\n5️⃣  自定义扩展字段 (markvault:*)');
  await testCustomExtensions();

  console.log('\n6️⃣  关系序列化');
  await testRelationSerialization();

  console.log('\n7️⃣  Flags 序列化');
  await testFlagsSerialization();

  console.log('\n8️⃣  往返测试 (Round-Trip)');
  await testRoundTrip();

  console.log('\n9️⃣  Collection 导出');
  await testCollectionExport();

  console.log('\n🔟 过滤功能');
  await testFiltering();

  console.log('\n1️⃣1️⃣ 边缘情况');
  await testEdgeCases();

  console.log('\n1️⃣2️⃣ Schema 合规性');
  await testSchemaCompliance();

  console.log('\n1️⃣3️⃣ 反序列化边缘情况');
  await testDeserializationEdgeCases();

  console.log('\n1️⃣4️⃣ 审计修复：遗漏字段序列化/往返');
  await testMissingFieldsAudit();

  console.log('\n1️⃣5️⃣ 审计修复：falsy 值往返');
  await testFalsyRoundTrip();

  console.log('\n1️⃣6️⃣ 审计修复：RangeSelector 语义');
  await testRangeSelectorSemantics();

  console.log('\n' + '═'.repeat(55));
  console.log(`\n📊 结果: ${pass} 通过 / ${fail} 失败 / ${pass + fail} 总计`);
  if (fail > 0) {
    console.log('❌ 部分测试失败！');
    process.exit(1);
  } else {
    console.log('✅ 所有测试通过！');
  }
}

runAll();
