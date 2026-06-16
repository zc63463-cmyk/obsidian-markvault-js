/**
 * UI 层纯逻辑测试
 *
 * 测试从 StatsView / AllNotesView / AnnotationSidebar 提取的纯逻辑:
 * - computeAnnotationStats: 统计聚合
 * - groupByDate: 按日期分组
 * - groupByFile: 按文件分组（降序排列）
 * - groupByColor: 按颜色分组
 * - formatRelativeTime: 相对时间格式化
 */

import type { Annotation } from '../src/types/annotation';

// ============================================================
// 提取的纯函数（从各 UI 模块中内联逻辑提取）
// ============================================================

/**
 * 计算标注统计数据（从 StatsView.render() 提取）
 */
interface AnnotationStats {
  total: number;
  byType: Record<string, number>;
  byColor: Record<string, number>;
  withNotes: number;
  withTags: number;
  fileCount: number;
  recentCount: number;
}

function computeAnnotationStats(annotations: Annotation[]): AnnotationStats {
  const byType: Record<string, number> = {};
  const byColor: Record<string, number> = {};
  let withNotes = 0;
  let withTags = 0;
  const fileSet = new Set<string>();
  const recentDay = Date.now() - 24 * 60 * 60 * 1000;
  let recentCount = 0;

  for (const a of annotations) {
    byType[a.type] = (byType[a.type] || 0) + 1;
    byColor[a.color] = (byColor[a.color] || 0) + 1;
    if (a.note && a.note.trim()) withNotes++;
    if (a.tags.length > 0) withTags++;
    fileSet.add(a.filePath);
    if (a.createdAt > recentDay) recentCount++;
  }

  return {
    total: annotations.length,
    byType,
    byColor,
    withNotes,
    withTags,
    fileCount: fileSet.size,
    recentCount,
  };
}

/**
 * 按创建日期分组（从 AllNotesView.renderTimelineView() 提取）
 */
function groupByDate(annotations: Annotation[]): Map<string, Annotation[]> {
  const groups = new Map<string, Annotation[]>();
  for (const a of annotations) {
    const date = new Date(a.createdAt).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date)!.push(a);
  }
  return groups;
}

/**
 * 按文件分组，降序排列（从 AllNotesView.renderByFileView() 提取）
 */
function groupByFile(annotations: Annotation[]): Map<string, Annotation[]> {
  const groups = new Map<string, Annotation[]>();
  for (const a of annotations) {
    const fileName = a.filePath.split('/').pop()?.replace('.md', '') || a.filePath;
    if (!groups.has(fileName)) groups.set(fileName, []);
    groups.get(fileName)!.push(a);
  }
  // 按分组大小降序排列
  const sorted = new Map(
    [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
  );
  return sorted;
}

/**
 * 按颜色分组（从 AllNotesView.renderByColorView() 提取）
 */
function groupByColor(annotations: Annotation[]): Map<string, Annotation[]> {
  const groups = new Map<string, Annotation[]>();
  for (const a of annotations) {
    if (!groups.has(a.color)) groups.set(a.color, []);
    groups.get(a.color)!.push(a);
  }
  return groups;
}

/**
 * 相对时间格式化（从 AnnotationSidebar.formatRelativeTime() 提取）
 */
function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 7) {
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  } else if (days > 0) {
    return `${days}d ago`;
  } else if (hours > 0) {
    return `${hours}h ago`;
  } else if (minutes > 0) {
    return `${minutes}m ago`;
  } else {
    return 'just now';
  }
}

// ============================================================
// 辅助：创建测试 Annotation
// ============================================================
function ann(overrides: Partial<Annotation> = {}): Annotation {
  return {
    uuid: overrides.uuid || crypto.randomUUID?.() || 'test-' + Math.random(),
    filePath: overrides.filePath || 'notes/test.md',
    type: overrides.type || 'highlight',
    color: overrides.color || 'yellow',
    text: overrides.text || 'test text',
    note: overrides.note ?? '',
    tags: overrides.tags || [],
    startOffset: overrides.startOffset ?? 0,
    endOffset: overrides.endOffset ?? 10,
    startLine: overrides.startLine ?? 0,
    endLine: overrides.endLine ?? 0,
    contextBefore: overrides.contextBefore ?? '',
    contextAfter: overrides.contextAfter ?? '',
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
  };
}

// ============================================================
// computeAnnotationStats
// ============================================================
async function testComputeAnnotationStats() {
  console.log('\n🔬 computeAnnotationStats');

  let p = 0, f = 0;

  // 空输入
  {
    const stats = computeAnnotationStats([]);
    if (stats.total === 0 && stats.fileCount === 0 && stats.recentCount === 0) {
      p++; console.log('  ✅ 空输入全部为0');
    } else { f++; console.log('  ❌ 空输入统计异常'); }
  }

  // 单条
  {
    const stats = computeAnnotationStats([ann()]);
    if (stats.total === 1 && stats.fileCount === 1) {
      p++; console.log('  ✅ 单条: total=1 fileCount=1');
    } else { f++; console.log(`  ❌ 单条: ${JSON.stringify(stats)}`); }
  }

  // 类型分布
  {
    const stats = computeAnnotationStats([
      ann({ type: 'highlight' }),
      ann({ type: 'highlight' }),
      ann({ type: 'bold' }),
    ]);
    if (stats.byType['highlight'] === 2 && stats.byType['bold'] === 1) {
      p++; console.log('  ✅ 类型分布正确');
    } else { f++; console.log(`  ❌ 类型分布: ${JSON.stringify(stats.byType)}`); }
  }

  // 颜色分布
  {
    const stats = computeAnnotationStats([
      ann({ color: 'yellow' }),
      ann({ color: 'blue' }),
      ann({ color: 'yellow' }),
    ]);
    if (stats.byColor['yellow'] === 2 && stats.byColor['blue'] === 1) {
      p++; console.log('  ✅ 颜色分布正确');
    } else { f++; console.log(`  ❌ 颜色分布: ${JSON.stringify(stats.byColor)}`); }
  }

  // 带备注
  {
    const stats = computeAnnotationStats([
      ann({ note: 'has note' }),
      ann({ note: '' }),
      ann({ note: '   ' }),
    ]);
    if (stats.withNotes === 1) {
      p++; console.log('  ✅ 备注统计: 空白备注不计入');
    } else { f++; console.log(`  ❌ 备注统计: withNotes=${stats.withNotes}`); }
  }

  // 带标签
  {
    const stats = computeAnnotationStats([
      ann({ tags: ['tag1', 'tag2'] }),
      ann({ tags: [] }),
    ]);
    if (stats.withTags === 1) {
      p++; console.log('  ✅ 标签统计正确');
    } else { f++; console.log(`  ❌ 标签统计: withTags=${stats.withTags}`); }
  }

  // 文件去重
  {
    const stats = computeAnnotationStats([
      ann({ filePath: 'a.md' }),
      ann({ filePath: 'a.md' }),
      ann({ filePath: 'b.md' }),
    ]);
    if (stats.fileCount === 2) {
      p++; console.log('  ✅ 文件去重正确');
    } else { f++; console.log(`  ❌ 文件去重: fileCount=${stats.fileCount}`); }
  }

  // 近期标注（24小时内）
  {
    const recent = Date.now() - 1000; // 1秒前
    const old = Date.now() - 25 * 60 * 60 * 1000; // 25小时前
    const stats = computeAnnotationStats([
      ann({ createdAt: recent }),
      ann({ createdAt: old }),
    ]);
    if (stats.recentCount === 1) {
      p++; console.log('  ✅ 近期标注统计: 24h内=1');
    } else { f++; console.log(`  ❌ 近期标注: recentCount=${stats.recentCount}`); }
  }

  // 边界时间（恰好24小时前）
  {
    const exactly24h = Date.now() - 24 * 60 * 60 * 1000 + 1; // 24h - 1ms
    const stats = computeAnnotationStats([ann({ createdAt: exactly24h })]);
    if (stats.recentCount === 1) {
      p++; console.log('  ✅ 边界: 恰好24h内');
    } else { f++; console.log(`  ❌ 边界: recentCount=${stats.recentCount}`); }
  }

  return { passed: p, failed: f };
}

// ============================================================
// groupByDate
// ============================================================
async function testGroupByDate() {
  console.log('\n🔬 groupByDate');

  let p = 0, f = 0;

  // 空输入
  if (groupByDate([]).size === 0) {
    p++; console.log('  ✅ 空输入返回空Map');
  } else { f++; console.log('  ❌ 空输入'); }

  // 单日
  {
    const groups = groupByDate([ann()]);
    if (groups.size === 1) {
      p++; console.log('  ✅ 单条=1组');
    } else { f++; console.log(`  ❌ 单条组数=${groups.size}`); }
  }

  // 同一天多条
  {
    const sameDay = Date.now();
    const groups = groupByDate([
      ann({ createdAt: sameDay }),
      ann({ createdAt: sameDay }),
    ]);
    if (groups.size === 1 && groups.values().next().value.length === 2) {
      p++; console.log('  ✅ 同一天归为一组');
    } else { f++; console.log('  ❌ 同一天分组错误'); }
  }

  // 不同天
  {
    const day1 = Date.now();
    const day2 = Date.now() - 48 * 60 * 60 * 1000;
    const groups = groupByDate([
      ann({ createdAt: day1 }),
      ann({ createdAt: day2 }),
    ]);
    if (groups.size === 2) {
      p++; console.log('  ✅ 不同天分2组');
    } else { f++; console.log(`  ❌ 不同天组数=${groups.size}`); }
  }

  return { passed: p, failed: f };
}

// ============================================================
// groupByFile
// ============================================================
async function testGroupByFile() {
  console.log('\n🔬 groupByFile');

  let p = 0, f = 0;

  // 空输入
  if (groupByFile([]).size === 0) {
    p++; console.log('  ✅ 空输入');
  } else { f++; console.log('  ❌ 空输入'); }

  // 文件名提取
  {
    const groups = groupByFile([ann({ filePath: 'dir/subdir/my note.md' })]);
    const key = [...groups.keys()][0];
    if (key === 'my note') {
      p++; console.log('  ✅ 提取文件名去掉路径和扩展名');
    } else { f++; console.log(`  ❌ 文件名: "${key}"`); }
  }

  // 降序排列
  {
    const groups = groupByFile([
      ann({ filePath: 'a.md' }),
      ann({ filePath: 'b.md' }),
      ann({ filePath: 'b.md' }),
    ]);
    const entries = [...groups.entries()];
    if (entries[0][0] === 'b' && entries[0][1].length === 2) {
      p++; console.log('  ✅ 多文件降序排列');
    } else { f++; console.log(`  ❌ 排列: ${JSON.stringify(entries.map(e => [e[0], e[1].length]))}`); }
  }

  // 无扩展名文件
  {
    const groups = groupByFile([ann({ filePath: 'noext' })]);
    const key = [...groups.keys()][0];
    if (key === 'noext') {
      p++; console.log('  ✅ 无扩展名文件保留原名');
    } else { f++; console.log(`  ❌ 无扩展名: "${key}"`); }
  }

  return { passed: p, failed: f };
}

// ============================================================
// groupByColor
// ============================================================
async function testGroupByColor() {
  console.log('\n🔬 groupByColor');

  let p = 0, f = 0;

  const groups = groupByColor([
    ann({ color: 'red' }),
    ann({ color: 'blue' }),
    ann({ color: 'red' }),
  ]);

  if (groups.get('red')?.length === 2 && groups.get('blue')?.length === 1) {
    p++; console.log('  ✅ 颜色分组正确');
  } else { f++; console.log('  ❌ 颜色分组错误'); }

  if (groupByColor([]).size === 0) {
    p++; console.log('  ✅ 空输入');
  } else { f++; console.log('  ❌ 空输入'); }

  return { passed: p, failed: f };
}

// ============================================================
// formatRelativeTime
// ============================================================
async function testFormatRelativeTime() {
  console.log('\n🔬 formatRelativeTime');

  let p = 0, f = 0;

  // just now
  {
    const result = formatRelativeTime(new Date(Date.now() - 5000));
    if (result === 'just now') {
      p++; console.log('  ✅ 5秒前 → just now');
    } else { f++; console.log(`  ❌ 5秒前 → "${result}"`); }
  }

  // minutes
  {
    const result = formatRelativeTime(new Date(Date.now() - 5 * 60 * 1000));
    if (result === '5m ago') {
      p++; console.log('  ✅ 5分钟前 → 5m ago');
    } else { f++; console.log(`  ❌ 5分钟前 → "${result}"`); }
  }

  // hours
  {
    const result = formatRelativeTime(new Date(Date.now() - 3 * 60 * 60 * 1000));
    if (result === '3h ago') {
      p++; console.log('  ✅ 3小时前 → 3h ago');
    } else { f++; console.log(`  ❌ 3小时前 → "${result}"`); }
  }

  // days (≤7)
  {
    const result = formatRelativeTime(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
    if (result === '2d ago') {
      p++; console.log('  ✅ 2天前 → 2d ago');
    } else { f++; console.log(`  ❌ 2天前 → "${result}"`); }
  }

  // days (>7)
  {
    const result = formatRelativeTime(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    // 应返回日期字符串如 "6月6日"
    if (!result.includes('d ago') && !result.includes('h ago')) {
      p++; console.log(`  ✅ 10天前 → 日期格式: "${result}"`);
    } else { f++; console.log(`  ❌ 10天前 → "${result}"`); }
  }

  // 恰好1小时边界
  {
    const result = formatRelativeTime(new Date(Date.now() - 60 * 60 * 1000 + 5000));
    if (result === '59m ago') {
      p++; console.log('  ✅ 59分59秒 → 59m ago');
    } else { f++; console.log(`  ❌ 边界 → "${result}"`); }
  }

  return { passed: p, failed: f };
}

// ============================================================
// Runner
// ============================================================
async function run() {
  console.log('🧪 UI Logic Pure Function Tests');

  const suites = [
    testComputeAnnotationStats,
    testGroupByDate,
    testGroupByFile,
    testGroupByColor,
    testFormatRelativeTime,
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
