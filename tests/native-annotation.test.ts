/**
 * native-annotation 单元测试 — 验证 native 标注的构建、解析、更新、删除
 */

import {
  buildNativeAnnotation,
  buildNativeAnchor,
  findNativeWrapper,
  parseNativeAnnotations,
  removeNativeAnnotation,
  stripNativeAnnotations,
  updateNativeAnnotation,
} from '../src/core/native-annotation';

async function runTests() {
  let passed = 0, failed = 0;
  const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e: any) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
  };

  console.log('\n🧪 Native Annotation Unit Tests\n');

  await test('buildNativeAnnotation generates new HTML wrappers', () => {
    const bold = buildNativeAnnotation({ uuid: 'u1', type: 'bold', color: 'yellow', text: 'bold text' });
    if (!bold.includes('data-uuid="u1"')) throw new Error('bold missing data-uuid');
    if (!bold.includes('data-type="bold"')) throw new Error('bold missing data-type');
    if (!bold.includes('<b class="markvault-native markvault-bold markvault-yellow markvault-clickable"')) throw new Error('bold wrapper class mismatch');

    const highlight = buildNativeAnnotation({ uuid: 'u2', type: 'highlight', color: 'green', text: 'highlight text' });
    if (!highlight.includes('<mark class="markvault-native markvault-highlight markvault-green markvault-clickable"')) throw new Error('highlight wrapper class mismatch');
    if (!highlight.includes('data-type="highlight"')) throw new Error('highlight missing data-type');

    const underline = buildNativeAnnotation({ uuid: 'u3', type: 'underline', color: 'blue', text: 'underline text' });
    if (!underline.includes('<u class="markvault-native markvault-underline markvault-blue markvault-clickable"')) throw new Error('underline wrapper class mismatch');
    if (!underline.includes('data-type="underline"')) throw new Error('underline missing data-type');
  });

  await test('findNativeWrapper recognizes new HTML wrappers', () => {
    const bold = buildNativeAnnotation({ uuid: 'u1', type: 'bold', color: 'yellow', text: 'bold text' });
    const boldAnchor = buildNativeAnchor('u1', 'bold', 'yellow');
    const boldWrapper = findNativeWrapper(bold, boldAnchor.length, 'bold');
    if (!boldWrapper) throw new Error('bold wrapper not found');
    if (boldWrapper.text !== 'bold text') throw new Error(`bold text mismatch: ${boldWrapper.text}`);

    const highlight = buildNativeAnnotation({ uuid: 'u2', type: 'highlight', color: 'green', text: 'highlight text' });
    const highlightAnchor = buildNativeAnchor('u2', 'highlight', 'green');
    const highlightWrapper = findNativeWrapper(highlight, highlightAnchor.length, 'highlight');
    if (!highlightWrapper) throw new Error('highlight wrapper not found');
    if (highlightWrapper.text !== 'highlight text') throw new Error(`highlight text mismatch: ${highlightWrapper.text}`);

    const underline = buildNativeAnnotation({ uuid: 'u3', type: 'underline', color: 'blue', text: 'underline text' });
    const underlineAnchor = buildNativeAnchor('u3', 'underline', 'blue');
    const underlineWrapper = findNativeWrapper(underline, underlineAnchor.length, 'underline');
    if (!underlineWrapper) throw new Error('underline wrapper not found');
    if (underlineWrapper.text !== 'underline text') throw new Error(`underline text mismatch: ${underlineWrapper.text}`);
  });

  await test('findNativeWrapper recognizes legacy wrappers', () => {
    const legacyBold = '%%mv:i:old1:bold:yellow%%**bold text**';
    const w1 = findNativeWrapper(legacyBold, '%%mv:i:old1:bold:yellow%%'.length, 'bold');
    if (!w1 || w1.text !== 'bold text') throw new Error('legacy bold not found');

    const legacyHighlight = '%%mv:i:old2:highlight:green%%==highlight text==';
    const w2 = findNativeWrapper(legacyHighlight, '%%mv:i:old2:highlight:green%%'.length, 'highlight');
    if (!w2 || w2.text !== 'highlight text') throw new Error('legacy highlight not found');

    const legacyUnderline = '%%mv:i:old3:underline:blue%%<u>underline text</u>';
    const w3 = findNativeWrapper(legacyUnderline, '%%mv:i:old3:underline:blue%%'.length, 'underline');
    if (!w3 || w3.text !== 'underline text') throw new Error('legacy underline not found');
  });

  await test('parseNativeAnnotations parses new wrappers', () => {
    const content = [
      buildNativeAnnotation({ uuid: 'a', type: 'bold', color: 'yellow', text: 'b' }),
      buildNativeAnnotation({ uuid: 'b', type: 'highlight', color: 'green', text: 'h' }),
      buildNativeAnnotation({ uuid: 'c', type: 'underline', color: 'blue', text: 'u' }),
    ].join(' ');

    const parsed = parseNativeAnnotations(content, 'test.md');
    if (parsed.length !== 3) throw new Error(`expected 3, got ${parsed.length}`);
    const map = new Map(parsed.map(p => [p.uuid, p]));
    if (map.get('a')?.type !== 'bold') throw new Error('bold type mismatch');
    if (map.get('b')?.text !== 'h') throw new Error('highlight text mismatch');
    if (map.get('c')?.format !== 'native') throw new Error('underline format mismatch');
  });

  await test('parseNativeAnnotations parses legacy wrappers', () => {
    const content = '%%mv:i:x:bold:yellow%%**b**%%mv:i:y:highlight:green%%==h==%%mv:i:z:underline:blue%%<u>u</u>';
    const parsed = parseNativeAnnotations(content, 'test.md');
    if (parsed.length !== 3) throw new Error(`expected 3, got ${parsed.length}`);
    const map = new Map(parsed.map(p => [p.uuid, p]));
    if (map.get('x')?.text !== 'b') throw new Error('legacy bold text mismatch');
    if (map.get('y')?.text !== 'h') throw new Error('legacy highlight text mismatch');
    if (map.get('z')?.text !== 'u') throw new Error('legacy underline text mismatch');
  });

  await test('updateNativeAnnotation changes color on new wrappers', () => {
    const content = buildNativeAnnotation({ uuid: 'u1', type: 'highlight', color: 'yellow', text: 'text' });
    const updated = updateNativeAnnotation(content, 'u1', { color: 'pink' });
    if (!updated) throw new Error('update returned null');
    if (!updated.includes('markvault-pink')) throw new Error('color not updated to pink');
    if (updated.includes('markvault-yellow')) throw new Error('old color still present');
    if (!updated.includes('>text</mark>')) throw new Error('text lost');
  });

  await test('updateNativeAnnotation upgrades legacy wrapper to new format', () => {
    const content = '%%mv:i:old:highlight:yellow%%==text==';
    const updated = updateNativeAnnotation(content, 'old', { color: 'purple' });
    if (!updated) throw new Error('update returned null');
    if (!updated.includes('<mark class="markvault-native markvault-highlight markvault-purple')) throw new Error('not upgraded to new wrapper');
    if (!updated.includes('data-uuid="old"')) throw new Error('uuid missing');
  });

  await test('removeNativeAnnotation removes new wrappers', () => {
    const content = buildNativeAnnotation({ uuid: 'u1', type: 'highlight', color: 'yellow', text: 'remove me' });
    const removed = removeNativeAnnotation(content, 'u1');
    if (removed !== 'remove me') throw new Error(`expected plain text, got: ${removed}`);
  });

  await test('removeNativeAnnotation removes legacy wrappers', () => {
    const content = '%%mv:i:old:underline:blue%%<u>remove me</u>';
    const removed = removeNativeAnnotation(content, 'old');
    if (removed !== 'remove me') throw new Error(`expected plain text, got: ${removed}`);
  });

  await test('stripNativeAnnotations strips all wrappers', () => {
    const content = [
      buildNativeAnnotation({ uuid: 'a', type: 'bold', color: 'yellow', text: 'b' }),
      buildNativeAnnotation({ uuid: 'b', type: 'highlight', color: 'green', text: 'h' }),
      '%%mv:i:c:underline:blue%%<u>u</u>',
    ].join(' ');
    const stripped = stripNativeAnnotations(content);
    if (stripped !== 'b h u') throw new Error(`unexpected stripped text: ${stripped}`);
  });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  if (failed > 0) process.exit(1);
}

runTests();
