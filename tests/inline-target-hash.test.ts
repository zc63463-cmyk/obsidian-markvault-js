/**
 * inline targetHash 测试
 *
 * 验证 inline 标注的 targetHash 指纹功能：
 * - buildMarkTag 生成 data-target-hash 属性
 * - parseAnnotationsFromMarkdown 解析 data-target-hash
 * - updateMarkTag 更新 data-target-hash
 * - targetHash 基于 computeSignature 计算
 */

import '../src/db/annotation-store';
import type { Annotation } from '../src/types/annotation';
import { buildMarkTag, parseAnnotationsFromMarkdown, updateMarkTag, removeMarkTag } from '../src/core/inline-annotation-parser';
import { computeSignature } from '../src/core/block-fingerprint';

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

function makeAnn(overrides: Partial<Annotation> & { uuid: string }): Annotation {
  return {
    uuid: overrides.uuid,
    text: overrides.text || 'test text',
    filePath: overrides.filePath || 'test.md',
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 1,
    kind: overrides.kind || 'inline',
    type: overrides.type || 'highlight',
    color: overrides.color || 'yellow',
    note: overrides.note || '',
    tags: overrides.tags || [],
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
    ...overrides,
  } as Annotation;
}

async function runTests() {
console.log('\n🧪 inline targetHash Tests');
console.log('═'.repeat(60));

// T1: buildMarkTag 包含 data-target-hash 属性
await test('buildMarkTag includes data-target-hash attribute', async () => {
  const ann = makeAnn({ uuid: 't1', text: 'hello world' });
  const tag = buildMarkTag(ann);
  const expectedHash = computeSignature('hello world');
  assert(tag.includes(`data-target-hash="${expectedHash}"`), `tag should contain data-target-hash, got: ${tag}`);
});

// T2: buildMarkTag 使用 annotation.targetHash 如果已设置
await test('buildMarkTag uses annotation.targetHash when provided', async () => {
  const ann = makeAnn({ uuid: 't2', text: 'hello world', targetHash: 'customhash123' });
  const tag = buildMarkTag(ann);
  assert(tag.includes('data-target-hash="customhash123"'), `tag should use provided targetHash`);
});

// T3: parseAnnotationsFromMarkdown 解析 data-target-hash
await test('parseAnnotationsFromMarkdown extracts targetHash', async () => {
  const text = 'hello world';
  const hash = computeSignature(text);
  const content = `<mark data-uuid="t3" data-type="highlight" data-color="yellow" class="markvault-highlight markvault-yellow" data-note="" data-target-hash="${hash}">${text}</mark>`;
  const results = parseAnnotationsFromMarkdown(content, 'test.md');
  assertEqual(results.length, 1, 'should parse 1 annotation');
  assertEqual(results[0].targetHash, hash, 'targetHash should match');
});

// T4: parseAnnotationsFromMarkdown 在没有 data-target-hash 时自动计算
await test('parseAnnotationsFromMarkdown auto-computes targetHash when missing', async () => {
  const text = 'auto hash text';
  const content = `<mark data-uuid="t4" data-type="highlight" data-color="yellow" class="markvault-highlight markvault-yellow" data-note="">${text}</mark>`;
  const results = parseAnnotationsFromMarkdown(content, 'test.md');
  assertEqual(results.length, 1, 'should parse 1 annotation');
  const expectedHash = computeSignature(text);
  assertEqual(results[0].targetHash, expectedHash, 'auto-computed targetHash should match');
});

// T5: updateMarkTag 更新 data-target-hash
await test('updateMarkTag updates data-target-hash', async () => {
  const oldHash = computeSignature('old text');
  const newHash = computeSignature('new text');
  const content = `<mark data-uuid="t5" data-type="highlight" data-color="yellow" class="markvault-highlight markvault-yellow" data-note="" data-target-hash="${oldHash}">old text</mark>`;
  const updated = updateMarkTag(content, 't5', { targetHash: newHash });
  assert(updated.includes(`data-target-hash="${newHash}"`), 'updated content should contain new hash');
  assert(!updated.includes(`data-target-hash="${oldHash}"`), 'updated content should not contain old hash');
});

// T6: updateMarkTag 添加 data-target-hash 到旧标注（无该属性时）
await test('updateMarkTag adds data-target-hash to legacy mark', async () => {
  const content = `<mark data-uuid="t6" data-type="highlight" data-color="yellow" class="markvault-highlight markvault-yellow" data-note="">legacy text</mark>`;
  const newHash = computeSignature('legacy text');
  const updated = updateMarkTag(content, 't6', { targetHash: newHash });
  assert(updated.includes(`data-target-hash="${newHash}"`), 'should add data-target-hash to legacy mark');
});

// T7: targetHash 对同一文本稳定
await test('targetHash is stable for same text', async () => {
  const text = 'stability test';
  const hash1 = computeSignature(text);
  const hash2 = computeSignature(text);
  assertEqual(hash1, hash2, 'same text should produce same hash');
});

// T8: targetHash 对不同文本不同
await test('targetHash differs for different text', async () => {
  const hash1 = computeSignature('text A');
  const hash2 = computeSignature('text B');
  assert(hash1 !== hash2, 'different text should produce different hash');
});

// T9: round-trip: build → parse → targetHash 一致
await test('round-trip: build → parse preserves targetHash', async () => {
  const ann = makeAnn({ uuid: 't9', text: 'round trip test' });
  const tag = buildMarkTag(ann);
  const parsed = parseAnnotationsFromMarkdown(tag, 'test.md');
  assertEqual(parsed.length, 1, 'should parse 1');
  assertEqual(parsed[0].targetHash, ann.targetHash || computeSignature('round trip test'), 'targetHash should match after round-trip');
});

// T10: 短文本也有 targetHash（解决短文本漂移恢复弱的问题）
await test('short text gets targetHash', async () => {
  const ann = makeAnn({ uuid: 't10', text: 'ab' });
  const tag = buildMarkTag(ann);
  assert(tag.includes('data-target-hash='), 'even short text should have targetHash');
  const parsed = parseAnnotationsFromMarkdown(tag, 'test.md');
  assert(parsed[0].targetHash, 'parsed short text should have targetHash');
});

// ── 报告 ──────────────────────────
console.log('\n' + '═'.repeat(60));
console.log(`🧪 inline targetHash Results: ${pass} passed, ${fail} failed, ${pass + fail} total`);

if (fail > 0) {
  process.exit(1);
}
}

runTests().catch(e => { console.error('Runner failed:', e); process.exit(1); });
