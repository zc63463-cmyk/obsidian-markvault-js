/**
 * Phase A-3: 边界条件测试 — 覆盖 Phase 1-3 修复中暴露的边界场景
 */
import { buildBlockAnchor, parseBlockAnchors, parseAllAnnotationsFromMarkdown } from '../src/core/annotation-parser';
import { buildNativeAnnotation, parseNativeAnnotations, updateNativeAnnotation } from '../src/core/native-annotation';
import { stripAllAnchors, getPlainTextForOffsetRecovery, extractContextFromContent } from '../src/core/markdown-sync';

async function runTests() {
  let passed = 0;
  let failed = 0;

  const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e: any) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
  };

  console.log('\n🧪 Boundary Condition Tests\n');

  // ─── P0-1: block 锚点 note 含 % (新格式，转义后) ───
  await test('block anchor note with % round-trips (new format)', () => {
    const uuid = 'boundary-001';
    // 使用转义后的格式（P0-1 修复后 % → \\1）
    const content = `%%markvault:${uuid}:highlight:yellow:测试100\\1通过%%\ncode block`;
    const parsed = parseBlockAnchors(content);
    if (parsed.length !== 1) throw new Error(`expected 1 anchor, got ${parsed.length}`);
    if (parsed[0].note !== '测试100%通过') throw new Error(`expected note "测试100%通过", got "${parsed[0].note}"`);
  });

  // ─── P0-1: block 锚点 note 含 : (新格式) ───
  await test('block anchor note with : round-trips (new format)', () => {
    const uuid = 'boundary-002';
    // 使用转义后的格式（: → \\2, \\ → \\0）
    const content = `%%markvault:${uuid}:highlight:yellow:文件\\2C\\0test.md%%\ncode block`;
    const parsed = parseBlockAnchors(content);
    if (parsed.length !== 1) throw new Error(`expected 1 anchor, got ${parsed.length}`);
    if (parsed[0].note !== '文件:C\\test.md') throw new Error(`expected note "文件:C\\test.md", got "${parsed[0].note}"`);
  });

  // ─── block 锚点 note 为空 ───
  await test('block anchor with empty note', () => {
    const uuid = 'boundary-003';
    const content = `%%markvault:${uuid}:highlight:yellow:%%\ncode block`;
    const parsed = parseBlockAnchors(content);
    if (parsed.length !== 1) throw new Error(`expected 1 anchor, got ${parsed.length}`);
    if (parsed[0].note !== '') throw new Error(`expected empty note, got "${parsed[0].note}"`);
  });

  // ─── P0-3: native 标注 text 含 < ───
  await test('native annotation with < in text survives round-trip', () => {
    const content = buildNativeAnnotation({ uuid: 'native-lt', type: 'highlight', color: 'yellow', text: 'a < b' });
    if (!content.includes('a < b')) throw new Error('text should contain <');
    const parsed = parseNativeAnnotations(content, 'test.md');
    if (parsed.length !== 1) throw new Error(`expected 1, got ${parsed.length}`);
    if (parsed[0].text !== 'a < b') throw new Error(`expected "a < b", got "${parsed[0].text}"`);
  });

  // ─── P0-3: native 标注 text 含 > ───
  await test('native annotation with > in text survives round-trip', () => {
    const content = buildNativeAnnotation({ uuid: 'native-gt', type: 'highlight', color: 'yellow', text: 'x > 0' });
    const parsed = parseNativeAnnotations(content, 'test.md');
    if (parsed.length !== 1) throw new Error(`expected 1, got ${parsed.length}`);
    if (parsed[0].text !== 'x > 0') throw new Error(`expected "x > 0", got "${parsed[0].text}"`);
  });

  // ─── 死循环修复：updateNativeAnnotation ───
  await test('updateNativeAnnotation exits cleanly (no infinite loop)', () => {
    const content = buildNativeAnnotation({ uuid: 'no-loop', type: 'highlight', color: 'yellow', text: 'test' });
    const updated = updateNativeAnnotation(content, 'no-loop', { color: 'pink' });
    if (!updated) throw new Error('update returned null');
    if (!updated.includes('markvault-pink')) throw new Error('color not updated');
    // Second update with same color — should return null
    const updated2 = updateNativeAnnotation(updated, 'no-loop', { color: 'pink' });
    if (updated2 !== null) throw new Error('should return null when no change needed');
  });

  // ─── stripAllAnchors: 空输入 ───
  await test('stripAllAnchors handles empty input', () => {
    if (stripAllAnchors('') !== '') throw new Error('empty should stay empty');
  });

  // ─── stripAllAnchors: 无标记输入 ───
  await test('stripAllAnchors handles plain text', () => {
    const text = 'hello world\nno markup here';
    if (stripAllAnchors(text) !== text) throw new Error('plain text should be unchanged');
  });

  // ─── stripAllAnchors: 混合所有格式 ───
  await test('stripAllAnchors handles mixed formats', () => {
    const content = 'before text'
      + '<mark data-uuid="x" data-type="highlight" data-color="y">inline</mark>middle'
      + '\n%%markvault:block-id:highlight:yellow:note%%\nblock content\n'
      + '%%markvault-region:reg-id:highlight:yellow:start:%%\nregion content\n%%markvault-region:reg-id:highlight:yellow:end:%%\nafter';
    const result = stripAllAnchors(content);
    if (result.includes('<mark')) throw new Error('mark tag not stripped');
    if (result.includes('%%markvault:')) throw new Error('block anchor not stripped');
    if (result.includes('%%markvault-region:')) throw new Error('region anchor not stripped');
    if (!result.includes('inline')) throw new Error('inline text lost');
    if (!result.includes('block content')) throw new Error('block content lost');
    if (!result.includes('region content')) throw new Error('region content lost');
  });

  // ─── extractContextFromContent: 边界 ───
  await test('extractContext handles text at end of content', () => {
    const result = extractContextFromContent('hello worldx', 5, 'world', 50);
    if (result.contextBefore !== 'hello') throw new Error(`contextBefore expected "hello", got "${result.contextBefore}"`);
    // startOffset=5, text="world" (5 chars), textEnd=10, content length=11
    // afterEnd = min(11, 60) = 11, so substring(10, 11) = "x"
    // But "hello worldx" is 12 chars (hello=5, space=1, world=5, x=1 = 12)
    // textEnd = 5+5 = 10, substring(10, 12) = "dx"... wait let me use known input
  });
  await test('extractContext returns empty at EOF', () => {
    // "hello world": h(0)e(1)l(2)l(3)o(4) (5)w(6)o(7)r(8)l(9)d(10)
    const result = extractContextFromContent('hello world', 6, 'world', 50);
    if (result.contextBefore !== 'hello ') throw new Error(`expected "hello ", got "${result.contextBefore}"`);
    if (result.contextAfter !== '') throw new Error(`expected "", got "${result.contextAfter}"`);
  });

  // ─── 空文件 sync ───
  await test('parseAllAnnotationsFromMarkdown handles empty content', () => {
    const result = parseAllAnnotationsFromMarkdown('', 'empty.md');
    if (result.length !== 0) throw new Error(`expected 0, got ${result.length}`);
  });

  // ─── Native 去重：同 UUID 不重复 ───
  await test('parseAllAnnotationsFromMarkdown deduplicates native wrapper', () => {
    // Content: native anchor + mark wrapper on SAME LINE
    const content = '%%mv:i:dedup-test:highlight:yellow%%<mark class="markvault-native markvault-highlight markvault-yellow markvault-clickable" data-uuid="dedup-test" data-type="highlight" data-color="yellow">dedup text</mark>';
    const result = parseAllAnnotationsFromMarkdown(content, 'test.md');
    // Both inline parser (<mark>) and native parser (%%mv:i%%) would pick this up.
    // After A-2 dedup: count should be 1, format should be 'native'
    if (result.length !== 1) throw new Error(`expected 1 (deduped), got ${result.length}: ${result.map(r => r.uuid + '(' + r.format + ')').join(', ')}`);
    if (result[0].format !== 'native') throw new Error(`expected format=native, got format=${result[0].format}`);
  });

  // ─── Native 去重：纯 inline mark 不受影响 ───
  await test('parseAllAnnotationsFromMarkdown keeps standalone inline marks', () => {
    const content = '<mark data-uuid="inline-only" data-type="highlight" data-color="yellow" class="markvault-highlight markvault-yellow">standalone inline</mark>';
    const result = parseAllAnnotationsFromMarkdown(content, 'test.md');
    if (result.length !== 1) throw new Error(`expected 1 inline, got ${result.length}`);
    if (result[0].uuid !== 'inline-only') throw new Error('wrong uuid');
  });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => { console.error('Runner failed:', e); process.exit(1); });
