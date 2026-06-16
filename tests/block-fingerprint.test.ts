/**
 * Block/Span 指纹定位测试
 *
 * 测试 src/core/block-fingerprint.ts 的 7 个纯函数
 */

import {
  computeSignature,
  detectBlockTypeAtLine,
  computeBlockSignature,
  computeSpanSignature,
  findBlockLineBySignature,
  findSpanLineBySignature,
} from '../src/core/block-fingerprint';

// ============================================================
// computeSignature
// ============================================================
async function testComputeSignature() {
  console.log('\n🔬 computeSignature');

  const tests: [string, string, string][] = [
    ['空字符串', '', ''],
    ['纯空白', '   \t  ', ''],
    ['短文本', 'hello', 'f923099'],
    ['相同输入产生相同输出', 'hello', 'f923099'],
    ['不同输入产生不同输出', 'world', '10a7356d'],
    ['前120字符截断', 'x'.repeat(200), computeSignature('x'.repeat(120))],
    ['空白标准化', 'hello   world', computeSignature('hello world')],
    ['换行符被标准化为空格', 'hello\nworld', computeSignature('hello world')],
  ];

  let passed = 0, failed = 0;
  for (const [label, input, expected] of tests) {
    const result = computeSignature(input);
    if (result === expected) {
      passed++;
      console.log(`  ✅ ${label}`);
    } else {
      failed++;
      console.log(`  ❌ ${label}: expected "${expected}", got "${result}"`);
    }
  }

  return { passed, failed };
}

// ============================================================
// detectBlockTypeAtLine
// ============================================================
async function testDetectBlockTypeAtLine() {
  console.log('\n🔬 detectBlockTypeAtLine');

  const tests: [string, string[], number, string][] = [
    ['代码块', ['```python', 'print("hello")', '```'], 0, 'code-block'],
    ['公式块', ['$$', 'E = mc^2', '$$'], 0, 'math-block'],
    ['Callout', ['> [!note] Title', '> Content'], 0, 'callout'],
    ['表格', ['| a | b |', '| --- | --- |', '| 1 | 2 |'], 0, 'table'],
    ['图片', ['![alt](url)'], 0, 'image'],
    // 注意: /^!\[/ 比 /^!\[\[/ 先检查，所以 ![[file]] 被 image 捕获
    // 这是一个已知的限制：嵌入检查在图片检查之后
    ['嵌入(已知限制)', ['![[file]]'], 0, 'image'],
    ['一级标题', ['# Title'], 0, 'heading'],
    ['六级标题', ['###### Small'], 0, 'heading'],
    ['无序列表 -', ['- item'], 0, 'list'],
    ['无序列表 *', ['* item'], 0, 'list'],
    ['无序列表 +', ['+ item'], 0, 'list'],
    ['有序列表', ['1. item'], 0, 'list'],
    ['有序列表10+', ['123. item'], 0, 'list'],
    ['普通段落', ['Hello world'], 0, 'paragraph'],
    ['越界索引(负)', [], -1, 'paragraph'],
    ['越界索引(超上限)', [], 0, 'paragraph'],
    ['非callout的>', ['> plain text'], 0, 'paragraph'],
    ['非列表的-', ['--separator'], 0, 'paragraph'],
  ];

  let passed = 0, failed = 0;
  for (const [label, lines, idx, expected] of tests) {
    const result = detectBlockTypeAtLine(lines, idx);
    if (result === expected) {
      passed++;
      console.log(`  ✅ ${label}: ${result}`);
    } else {
      failed++;
      console.log(`  ❌ ${label}: expected "${expected}", got "${result}"`);
    }
  }

  return { passed, failed };
}

// ============================================================
// computeBlockSignature
// ============================================================
async function testComputeBlockSignature() {
  console.log('\n🔬 computeBlockSignature');

  const lines = ['# My Title', 'Hello world paragraph', '```js', "console.log('hi')", '```'];
  const sigTitle = computeBlockSignature(lines, 0);
  const sigPara = computeBlockSignature(lines, 1);
  const sigCode = computeBlockSignature(lines, 2);

  let passed = 0, failed = 0;

  // 标题和段落应该有不同的签名
  if (sigTitle !== sigPara) {
    passed++; console.log('  ✅ 标题和段落签名不同');
  } else {
    failed++; console.log('  ❌ 标题和段落签名相同');
  }

  // 相同输入应产生相同签名
  if (computeBlockSignature(lines, 0) === sigTitle) {
    passed++; console.log('  ✅ 确定性：相同输入产生相同签名');
  } else {
    failed++; console.log('  ❌ 确定性失败');
  }

  // 代码块有签名
  if (sigCode.length > 0) {
    passed++; console.log('  ✅ 代码块产生有效签名');
  } else {
    failed++; console.log('  ❌ 代码块签名为空');
  }

  // 空行数组
  const emptySig = computeBlockSignature([], 0);
  if (emptySig === '') {
    passed++; console.log('  ✅ 空数组返回空签名');
  } else {
    failed++; console.log('  ❌ 空数组应返回空签名');
  }

  return { passed, failed };
}

// ============================================================
// computeSpanSignature
// ============================================================
async function testComputeSpanSignature() {
  console.log('\n🔬 computeSpanSignature');

  let passed = 0, failed = 0;

  const sig = computeSpanSignature('target text');
  if (sig === computeSignature('target text')) {
    passed++; console.log('  ✅ computeSpanSignature = computeSignature（别名确认）');
  } else {
    failed++; console.log('  ❌ 别名不一致');
  }

  if (computeSpanSignature('') === '') {
    passed++; console.log('  ✅ 空文本返回空签名');
  } else {
    failed++; console.log('  ❌ 空文本签名失败');
  }

  return { passed, failed };
}

// ============================================================
// findBlockLineBySignature
// ============================================================
async function testFindBlockLineBySignature() {
  console.log('\n🔬 findBlockLineBySignature');

  let passed = 0, failed = 0;

  // 基础文档
  const lines = [
    '# Title',
    'First paragraph text.',
    '## Section',
    'Target paragraph here.',
    'Another paragraph.',
    '### Sub',
    'Other text.',
  ];

  const targetSig = computeBlockSignature(lines, 3, detectBlockTypeAtLine(lines, 3));

  // 测试1: 精确匹配
  const found = findBlockLineBySignature(lines, 'paragraph', targetSig, 3, 5);
  if (found === 3) {
    passed++; console.log('  ✅ 精确匹配找到目标行');
  } else {
    failed++; console.log(`  ❌ 精确匹配失败: expected 3, got ${found}`);
  }

  // 测试2: 附近匹配（指纹已移动到第5行）
  const linesMoved = [
    '# Title',
    '## Section',
    'Target paragraph here.',  // 从3移到2
    'First paragraph text.',
    'Another paragraph.',
    '### Sub',
    'Other text.',
  ];
  const movedFound = findBlockLineBySignature(linesMoved, 'paragraph', targetSig, 5, 5);
  if (movedFound !== null) {
    passed++; console.log(`  ✅ 附近匹配: 行${movedFound}（目标行已移动）`);
  } else {
    failed++; console.log('  ❌ 附近匹配失败: 未找到');
  }

  // 测试3: 空签名
  if (findBlockLineBySignature(lines, 'paragraph', '', 3) === null) {
    passed++; console.log('  ✅ 空签名返回null');
  } else {
    failed++; console.log('  ❌ 空签名应返回null');
  }

  // 测试4: 类型不匹配
  const headingSig = computeBlockSignature(lines, 0, 'heading');
  const wrongTypeFound = findBlockLineBySignature(lines, 'code-block', headingSig, 0, 5);
  if (wrongTypeFound === null) {
    passed++; console.log('  ✅ 类型不匹配返回null');
  } else {
    failed++; console.log(`  ❌ 类型不匹配应返回null, got ${wrongTypeFound}`);
  }

  // 测试5: paragraph 类型应匹配任何类型（宽松模式）
  const paraFound = findBlockLineBySignature(lines, 'paragraph', headingSig, 0, 5);
  if (paraFound !== null) {
    passed++; console.log('  ✅ paragraph类型可匹配heading（宽松策略）');
  } else {
    failed++; console.log('  ❌ paragraph类型应匹配heading');
  }

  // 测试6: 多候选选最近
  const dupLines = ['same', 'same', 'same'];
  const dupSig = computeSignature('same');
  const nearest = findBlockLineBySignature(dupLines, 'paragraph', dupSig, 1, 5);
  if (nearest === 1) {
    passed++; console.log('  ✅ 多候选选择最近的行');
  } else {
    failed++; console.log(`  ❌ 多候选最近行: expected 1, got ${nearest}`);
  }

  // 测试7: 搜索窗口外找不到（target 在行2，搜索窗口1=仅行0-1）
  const outOfWindow = findBlockLineBySignature(lines, 'paragraph', targetSig, 0, 1);
  // lines[3] 是 target，但 preferredLine=0, searchWindow=1 → 搜索行 0-1
  if (outOfWindow === null) {
    passed++; console.log('  ✅ 搜索窗口外返回null');
  } else {
    failed++; console.log(`  ❌ 搜索窗口外应返回null, got ${outOfWindow}`);
  }

  return { passed, failed };
}

// ============================================================
// findSpanLineBySignature
// ============================================================
async function testFindSpanLineBySignature() {
  console.log('\n🔬 findSpanLineBySignature');

  let passed = 0, failed = 0;

  const lines = [
    '# Title',
    'Some text with target content.',
    'Another line here.',
    '%%markvault-span:abc:%%',
    'Target content line here.',
    'More text.',
  ];

  const targetSig = computeSignature('Target content line here.');

  // 测试1: 精确匹配
  const found = findSpanLineBySignature(lines, targetSig, 4, 5);
  if (found === 4) {
    passed++; console.log('  ✅ 精确匹配');
  } else {
    failed++; console.log(`  ❌ 精确匹配: expected 4, got ${found}`);
  }

  // 测试2: 跳过锚点行
  const markvaultLineSig = computeSignature('%%markvault-span:abc:%%');
  const skipFound = findSpanLineBySignature(lines, markvaultLineSig, 3, 5);
  if (skipFound === null) {
    passed++; console.log('  ✅ 跳过 %%markvault%% 锚点行');
  } else {
    failed++; console.log(`  ❌ 应跳过锚点行, got line ${skipFound}`);
  }

  // 测试3: 跳过空行
  const linesWithBlank = ['', 'target', ''];
  const blankSig = computeSignature('target');
  const blankFound = findSpanLineBySignature(linesWithBlank, blankSig, 1, 2);
  if (blankFound === 1) {
    passed++; console.log('  ✅ 跳过空行');
  } else {
    failed++; console.log(`  ❌ 跳过空行: expected 1, got ${blankFound}`);
  }

  // 测试4: 空签名
  if (findSpanLineBySignature(lines, '', 0) === null) {
    passed++; console.log('  ✅ 空签名返回null');
  } else {
    failed++; console.log('  ❌ 空签名应返回null');
  }

  // 测试5: 多候选选最近
  const dupLines = ['same text', 'same text', 'same text'];
  const dupSig = computeSignature('same text');
  const nearest = findSpanLineBySignature(dupLines, dupSig, 1, 5);
  if (nearest === 1) {
    passed++; console.log('  ✅ 多候选选择最近的行');
  } else {
    failed++; console.log(`  ❌ 多候选: expected 1, got ${nearest}`);
  }

  return { passed, failed };
}

// ============================================================
// Runner
// ============================================================
async function run() {
  console.log('🧪 Block Fingerprint Unit Tests');

  const suites = [
    testComputeSignature,
    testDetectBlockTypeAtLine,
    testComputeBlockSignature,
    testComputeSpanSignature,
    testFindBlockLineBySignature,
    testFindSpanLineBySignature,
  ];

  let totalPassed = 0, totalFailed = 0;

  for (const suite of suites) {
    const { passed, failed } = await suite();
    totalPassed += passed;
    totalFailed += failed;
  }

  console.log(`\n📊 Results: ${totalPassed} passed, ${totalFailed} failed, ${totalPassed + totalFailed} total\n`);
  process.exit(totalFailed > 0 ? 1 : 0);
}

run();
