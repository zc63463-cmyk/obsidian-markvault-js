/**
 * Block 双锚点标注单元测试
 */

import {
  buildBlockAnchorStart,
  buildBlockAnchorEnd,
  parseBlockDoubleAnchors,
  findBlockDoubleAnchorRange,
  removeBlockAnchor,
  updateBlockAnchor,
  findBlockContentEndLine,
  findBlockTargetLine,
} from '../src/core/annotation-parser';

let _c = 0;
function uuid() {
  return `b-${++_c}`;
}

async function runTests() {
  let passed = 0, failed = 0;
  const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e: any) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
  };

  console.log('\n🧪 Block Double Anchor Unit Tests\n');

  await test('buildBlockAnchorStart/End produce correct format', () => {
    const id = uuid();
    const start = buildBlockAnchorStart({ uuid: id, type: 'highlight', color: 'yellow', note: 'hello:world' });
    const end = buildBlockAnchorEnd({ uuid: id, type: 'highlight', color: 'yellow', note: 'hello:world' });
    if (!start.includes(`%%markvault-block:${id}:highlight:yellow:start:`)) throw new Error('start format mismatch');
    if (!end.includes(`%%markvault-block:${id}:highlight:yellow:end:`)) throw new Error('end format mismatch');
    if (!start.includes('hello\\2world')) throw new Error('note colon not escaped');
  });

  await test('parseBlockDoubleAnchors groups start/end', () => {
    const id = uuid();
    const content = `%%markvault-block:${id}:bold:blue:start:%%\nSome code\n%%markvault-block:${id}:bold:blue:end:%%`;
    const anchors = parseBlockDoubleAnchors(content);
    if (anchors.length !== 2) throw new Error(`expected 2 anchors, got ${anchors.length}`);
    if (anchors[0].position !== 'start' || anchors[1].position !== 'end') throw new Error('positions wrong');
    if (anchors[0].uuid !== id || anchors[0].type !== 'bold' || anchors[0].color !== 'blue') throw new Error('attrs wrong');
  });

  await test('findBlockDoubleAnchorRange computes content range', () => {
    const id = uuid();
    const content = `%%markvault-block:${id}:highlight:yellow:start:%%\n\`\`\`ts\nconst x = 1;\n\`\`\`\n%%markvault-block:${id}:highlight:yellow:end:%%`;
    const range = findBlockDoubleAnchorRange(content, id);
    if (!range) throw new Error('range not found');
    if (range.targetLine !== 2) throw new Error(`expected targetLine 2, got ${range.targetLine}`);
    if (range.endLine !== 2) throw new Error(`expected endLine 2, got ${range.endLine}`);
    if (!range.text.includes('const x = 1')) throw new Error('content text wrong');
  });

  await test('removeBlockAnchor removes double anchors and preserves content', () => {
    const id = uuid();
    const content = `before\n%%markvault-block:${id}:highlight:yellow:start:%%\nblock text\n%%markvault-block:${id}:highlight:yellow:end:%%\nafter`;
    const removed = removeBlockAnchor(content, id);
    if (removed.includes('markvault-block')) throw new Error('anchors remain');
    if (!removed.includes('block text')) throw new Error('content lost');
  });

  await test('updateBlockAnchor updates double anchors', () => {
    const id = uuid();
    const content = `%%markvault-block:${id}:highlight:yellow:start:%%\nblock text\n%%markvault-block:${id}:highlight:yellow:end:%%`;
    const updated = updateBlockAnchor(content, id, { color: 'green', note: 'n' });
    if (!updated.includes(':green:')) throw new Error('color not updated');
    if (!updated.includes(`:${id}:highlight:green:start:n%%`) && !updated.includes(`:${id}:highlight:green:end:n%%`)) throw new Error('note not updated');
    if (updated.split('markvault-block').length - 1 !== 2) throw new Error('anchor count wrong');
  });

  await test('remove/update still work with old single anchors', () => {
    const id = uuid();
    const content = `%%markvault:${id}:highlight:yellow:old note%%\nblock text`;
    const removed = removeBlockAnchor(content, id);
    if (removed.includes('markvault:')) throw new Error('old anchor remain');
    const updated = updateBlockAnchor(content, id, { color: 'green' });
    // v5.3: 更新旧格式锚点时自动升级为新格式（含 alias 占位符 _）
    if (!updated.includes(`%%markvault:${id}:highlight:green:_:old note%%`)) throw new Error('old anchor not updated');
  });

  await test('findBlockContentEndLine skips fences and empty lines', () => {
    const content = '```\ncode\n```\n\n%%markvault-block:x:highlight:yellow:end:%%';
    const endLine = findBlockContentEndLine(content, 4);
    if (endLine !== 1) throw new Error(`expected endLine 1, got ${endLine}`);
  });

  await test('findBlockTargetLine skips start anchor and opening fence', () => {
    const content = `%%markvault-block:x:highlight:yellow:start:%%\n\`\`\`\ncode\n\`\`\``;
    const targetLine = findBlockTargetLine(content, 0);
    if (targetLine !== 2) throw new Error(`expected targetLine 2, got ${targetLine}`);
  });

  await test('indented list anchors are parsed correctly', () => {
    const id = uuid();
    const content = `1. First\n   %%markvault-block:${id}:highlight:yellow:start:%%\n2. Second\n   %%markvault-block:${id}:highlight:yellow:end:%%\n3. Third`;
    const range = findBlockDoubleAnchorRange(content, id);
    if (!range) throw new Error('range not found');
    if (range.targetLine !== 2) throw new Error(`expected targetLine 2, got ${range.targetLine}`);
    if (range.endLine !== 2) throw new Error(`expected endLine 2, got ${range.endLine}`);
    if (!range.text.includes('Second')) throw new Error('content text wrong');
  });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => { console.error('Runner failed:', e); process.exit(1); });
