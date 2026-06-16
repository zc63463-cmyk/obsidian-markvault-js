/**
 * 列表工具函数测试（从 context-menu.ts 提取为 list-utils.ts）
 *
 * 测试 src/ui/editor/list-utils.ts 的 6 个纯函数
 */

import {
  getListItemPrefix,
  getBlockAnchorPrefixesForListItem,
  offsetToLineCh,
  adjustRegionStartOffsetForListItem,
  adjustRegionEndOffsetForListItem,
} from '../src/ui/editor/list-utils';

// ============================================================
// getListItemPrefix
// ============================================================
async function testGetListItemPrefix() {
  console.log('\n🔬 getListItemPrefix');
  let p = 0, f = 0;

  { const r = getListItemPrefix('- item');
    if (r && r.marker === '- ' && r.childIndent === '  ') { p++; console.log('  ✅ 无序列表 -'); }
    else { f++; console.log(`  ❌: ${JSON.stringify(r)}`); } }

  { const r = getListItemPrefix('* item');
    if (r && r.marker === '* ' && r.childIndent === '  ') { p++; console.log('  ✅ 无序列表 *'); }
    else { f++; console.log(`  ❌: ${JSON.stringify(r)}`); } }

  { const r = getListItemPrefix('+ item');
    if (r && r.marker === '+ ' && r.childIndent === '  ') { p++; console.log('  ✅ 无序列表 +'); }
    else { f++; console.log(`  ❌: ${JSON.stringify(r)}`); } }

  { const r = getListItemPrefix('1. item');
    if (r && r.marker === '1. ' && r.childIndent === '   ') { p++; console.log('  ✅ 有序列表 1.'); }
    else { f++; console.log(`  ❌: ${JSON.stringify(r)}`); } }

  { const r = getListItemPrefix('123. item');
    if (r && r.marker === '123. ' && r.childIndent === '     ') { p++; console.log('  ✅ 有序列表 123.'); }
    else { f++; console.log(`  ❌: ${JSON.stringify(r)}`); } }

  { const r = getListItemPrefix('  - nested');
    if (r && r.marker === '  - ' && r.childIndent === '    ') { p++; console.log('  ✅ 缩进列表'); }
    else { f++; console.log(`  ❌: ${JSON.stringify(r)}`); } }

  { const r = getListItemPrefix('plain text');
    if (r === null) { p++; console.log('  ✅ 非列表返回null'); }
    else { f++; console.log('  ❌ 非列表'); } }

  { const r = getListItemPrefix('-- separator');
    if (r === null) { p++; console.log('  ✅ --不是列表'); }
    else { f++; console.log('  ❌ --误判'); } }

  return { passed: p, failed: f };
}

// ============================================================
// getBlockAnchorPrefixesForListItem
// ============================================================
async function testGetBlockAnchorPrefixesForListItem() {
  console.log('\n🔬 getBlockAnchorPrefixesForListItem');
  let p = 0, f = 0;

  {
    const lines = ['- parent', '- target'];
    const r = getBlockAnchorPrefixesForListItem(lines, 1);
    if (r.startAnchorPrefix === '  ' && r.endAnchorPrefix === '  ') {
      p++; console.log('  ✅ 同级列表: start=childIndent, end=childIndent');
    } else { f++; console.log(`  ❌: ${JSON.stringify(r)}`); }
  }

  {
    const lines = ['- first'];
    const r = getBlockAnchorPrefixesForListItem(lines, 0);
    if (r.startAnchorPrefix === '' && r.endAnchorPrefix === '  ') {
      p++; console.log('  ✅ 首个列表: start为空');
    } else { f++; console.log(`  ❌: ${JSON.stringify(r)}`); }
  }

  {
    const lines = ['- parent', '  - child', '  - target'];
    const r = getBlockAnchorPrefixesForListItem(lines, 2);
    if (r.startAnchorPrefix === '    ') {
      p++; console.log('  ✅ 嵌套列表: start=前同级childIndent');
    } else { f++; console.log(`  ❌: ${JSON.stringify(r)}`); }
  }

  {
    const r = getBlockAnchorPrefixesForListItem(['plain'], 0);
    if (r.startAnchorPrefix === '' && r.endAnchorPrefix === '') {
      p++; console.log('  ✅ 非列表都为空');
    } else { f++; console.log(`  ❌: ${JSON.stringify(r)}`); }
  }

  {
    const r = getBlockAnchorPrefixesForListItem([], 0);
    if (r.startAnchorPrefix === '' && r.endAnchorPrefix === '') {
      p++; console.log('  ✅ 越界都为空');
    } else { f++; console.log(`  ❌: ${JSON.stringify(r)}`); }
  }

  return { passed: p, failed: f };
}

// ============================================================
// offsetToLineCh
// ============================================================
async function testOffsetToLineCh() {
  console.log('\n🔬 offsetToLineCh');
  let p = 0, f = 0;

  const content = 'line1\nline2\nline3';

  { const r = offsetToLineCh(content, 0);
    if (r.line === 0 && r.ch === 0) { p++; console.log('  ✅ offset=0 → (0,0)'); }
    else { f++; console.log(`  ❌: ${JSON.stringify(r)}`); } }

  { const r = offsetToLineCh(content, 6);
    if (r.line === 1 && r.ch === 0) { p++; console.log('  ✅ offset=6 → (1,0)'); }
    else { f++; console.log(`  ❌: ${JSON.stringify(r)}`); } }

  { const r = offsetToLineCh(content, 8);
    if (r.line === 1 && r.ch === 2) { p++; console.log('  ✅ offset=8 → (1,2)'); }
    else { f++; console.log(`  ❌: ${JSON.stringify(r)}`); } }

  { const r = offsetToLineCh(content, 13);
    if (r.line === 2 && r.ch === 1) { p++; console.log('  ✅ offset=13 → (2,1)'); }
    else { f++; console.log(`  ❌: ${JSON.stringify(r)}`); } }

  return { passed: p, failed: f };
}

// ============================================================
// adjustRegionStartOffsetForListItem
// ============================================================
async function testAdjustRegionStart() {
  console.log('\n🔬 adjustRegionStartOffsetForListItem');
  let p = 0, f = 0;

  // offset 正好在列表项行首
  const content = '- item1\n- item2';
  { const r = adjustRegionStartOffsetForListItem(content, 8);
    if (r === 10) { p++; console.log('  ✅ 行首→后移到marker后: 8→10'); }
    else { f++; console.log(`  ❌: ${r}`); } }

  { const r = adjustRegionStartOffsetForListItem('plain text', 0);
    if (r === 0) { p++; console.log('  ✅ 非列表不变'); }
    else { f++; console.log(`  ❌: ${r}`); } }

  { const r = adjustRegionStartOffsetForListItem(content, 9);
    if (r === 9) { p++; console.log('  ✅ 非行首不变'); }
    else { f++; console.log(`  ❌: ${r}`); } }

  return { passed: p, failed: f };
}

// ============================================================
// adjustRegionEndOffsetForListItem
// ============================================================
async function testAdjustRegionEnd() {
  console.log('\n🔬 adjustRegionEndOffsetForListItem');
  let p = 0, f = 0;

  const content = '- item1\n- item2';
  { const r = adjustRegionEndOffsetForListItem(content, 8);
    if (r === 7) { p++; console.log('  ✅ 行首→前移到上行尾: 8→7'); }
    else { f++; console.log(`  ❌: ${r}`); } }

  { const r = adjustRegionEndOffsetForListItem('plain', 0);
    if (r === 0) { p++; console.log('  ✅ 非列表不变'); }
    else { f++; console.log(`  ❌: ${r}`); } }

  return { passed: p, failed: f };
}

// ============================================================
// Runner
// ============================================================
async function run() {
  console.log('🧪 List Utils Pure Function Tests');

  const suites = [testGetListItemPrefix, testGetBlockAnchorPrefixesForListItem,
    testOffsetToLineCh, testAdjustRegionStart, testAdjustRegionEnd];
  let tp = 0, tf = 0;
  for (const s of suites) {
    const { passed, failed } = await s();
    tp += passed; tf += failed;
  }

  console.log(`\n📊 Results: ${tp} passed, ${tf} failed, ${tp + tf} total\n`);
  process.exit(tf > 0 ? 1 : 0);
}

run();
