/**
 * region-annotation 单元测试
 */

import {
  buildRegionAnchor,
  findRegionRange,
  parseRegionAnnotations,
  removeRegionAnnotation,
  updateRegionAnnotation,
  stripRegionAnnotations,
} from '../src/core/region-annotation';

async function runTests() {
  let passed = 0, failed = 0;
  const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e: any) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
  };

  console.log('\n🧪 Region Annotation Unit Tests\n');

  await test('buildRegionAnchor generates start/end anchors', () => {
    const start = buildRegionAnchor({ uuid: 'u1', type: 'highlight', color: 'yellow', note: 'note:1' }, 'start');
    if (!start.includes('markvault-region:u1:highlight:yellow:start:note\\21')) {
      throw new Error(`unexpected start anchor: ${start}`);
    }
    const end = buildRegionAnchor({ uuid: 'u1', type: 'highlight', color: 'yellow', note: '' }, 'end');
    if (!end.includes('markvault-region:u1:highlight:yellow:end:')) throw new Error(`unexpected end anchor: ${end}`);
  });

  await test('findRegionRange locates a region', () => {
    const content = '%%markvault-region:u1:highlight:yellow:start:%%hello world%%markvault-region:u1:highlight:yellow:end:%%';
    const range = findRegionRange(content, 'u1');
    if (!range) throw new Error('range not found');
    if (range.text !== 'hello world') throw new Error(`text mismatch: ${range.text}`);
    if (range.type !== 'highlight') throw new Error('type mismatch');
    if (range.color !== 'yellow') throw new Error('color mismatch');
  });

  await test('parseRegionAnnotations parses a single region', () => {
    const content = 'prefix%%markvault-region:u1:highlight:green:start:%%content%%markvault-region:u1:highlight:green:end:%%suffix';
    const parsed = parseRegionAnnotations(content, 'test.md');
    if (parsed.length !== 1) throw new Error(`expected 1, got ${parsed.length}`);
    if (parsed[0].uuid !== 'u1') throw new Error('uuid mismatch');
    if (parsed[0].text !== 'content') throw new Error(`text mismatch: ${parsed[0].text}`);
    if (parsed[0].kind !== 'region') throw new Error('kind mismatch');
  });

  await test('parseRegionAnnotations handles nested regions', () => {
    const content =
      '%%markvault-region:outer:highlight:yellow:start:%%' +
      'outer' +
      '%%markvault-region:inner:highlight:blue:start:%%inner%%markvault-region:inner:highlight:blue:end:%%' +
      'outer' +
      '%%markvault-region:outer:highlight:yellow:end:%%';
    const parsed = parseRegionAnnotations(content, 'test.md');
    if (parsed.length !== 2) throw new Error(`expected 2, got ${parsed.length}`);
    const outer = parsed.find(p => p.uuid === 'outer');
    const inner = parsed.find(p => p.uuid === 'inner');
    if (!outer || !inner) throw new Error('missing region');
    if (outer.text !== 'outer%%markvault-region:inner:highlight:blue:start:%%inner%%markvault-region:inner:highlight:blue:end:%%outer') {
      throw new Error(`outer text mismatch: ${outer.text}`);
    }
    if (inner.text !== 'inner') throw new Error(`inner text mismatch: ${inner.text}`);
  });

  await test('removeRegionAnnotation removes anchors and preserves content', () => {
    const content = 'a%%markvault-region:u1:highlight:yellow:start:%%b%%markvault-region:u1:highlight:yellow:end:%%c';
    const removed = removeRegionAnnotation(content, 'u1');
    if (removed !== 'abc') throw new Error(`unexpected: ${removed}`);
  });

  await test('updateRegionAnnotation changes color and note', () => {
    const content = '%%markvault-region:u1:highlight:yellow:start:%%text%%markvault-region:u1:highlight:yellow:end:%%';
    const updated = updateRegionAnnotation(content, 'u1', { color: 'purple', note: 'new note' });
    if (!updated) throw new Error('update returned null');
    if (!updated.includes('markvault-region:u1:highlight:purple:start:new note')) throw new Error('start anchor not updated');
    if (!updated.includes('markvault-region:u1:highlight:purple:end:new note')) throw new Error('end anchor not updated');
    if (!updated.includes('%%markvault-region:u1:highlight:purple:start:new note%%text%%markvault-region:u1:highlight:purple:end:new note%%')) throw new Error('text lost');
  });

  await test('stripRegionAnnotations strips all region anchors', () => {
    const content =
      '%%markvault-region:a:highlight:yellow:start:%%x%%markvault-region:a:highlight:yellow:end:%%' +
      '%%markvault-region:b:highlight:green:start:%%y%%markvault-region:b:highlight:green:end:%%';
    const stripped = stripRegionAnnotations(content);
    if (stripped !== 'xy') throw new Error(`unexpected: ${stripped}`);
  });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  if (failed > 0) process.exit(1);
}

runTests();
