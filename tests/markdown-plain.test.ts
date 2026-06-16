/**
 * Markdown → 纯文本转换测试
 *
 * 测试 src/core/markdown-plain.ts 的 markdownToPlainWithMap()
 */

import { markdownToPlainWithMap } from '../src/core/markdown-plain';

function ok(cond: boolean, msg: string): boolean {
  if (cond) { console.log(`  ✅ ${msg}`); return true; }
  else { console.log(`  ❌ ${msg}`); return false; }
}

async function testMarkdownToPlainWithMap() {
  console.log('\n🔬 markdownToPlainWithMap');
  let p = 0, f = 0;
  const P = () => p++;
  const F = () => f++;

  // ─── 基础 ───
  {
    const { plain, map } = markdownToPlainWithMap('hello');
    ok(plain === 'hello', '纯文本无标记') ? P() : F();
    ok(map.length === 5 && map[0] === 0 && map[4] === 4, '映射[0]=0 [4]=4') ? P() : F();
  }

  // ─── 空输入 ───
  {
    const { plain, map } = markdownToPlainWithMap('');
    ok(plain === '', '空输入→空输出') ? P() : F();
    ok(map.length === 0, '映射为空') ? P() : F();
  }

  // ─── 粗体 ───
  { ok(markdownToPlainWithMap('**bold**').plain === 'bold', '**粗体**→移除标记保留内容') ? P() : F(); }

  // ─── 斜体 ───
  { ok(markdownToPlainWithMap('*italic*').plain === 'italic', '*斜体*→保留内容') ? P() : F(); }

  // ─── 高亮 ───
  { ok(markdownToPlainWithMap('==highlight==').plain === 'highlight', '==高亮==→保留内容') ? P() : F(); }

  // ─── 删除线 ───
  { ok(markdownToPlainWithMap('~~strike~~').plain === 'strike', '~~删除线~~→保留内容') ? P() : F(); }

  // ─── 内联代码 ───
  { ok(markdownToPlainWithMap('`code`').plain === 'code', '`代码`→保留内容去掉反引号') ? P() : F(); }

  // ─── 未闭合的内联代码 ───
  { ok(markdownToPlainWithMap('`unclosed').plain === '`unclosed', '未闭合`→保留原样') ? P() : F(); }

  // ─── Wiki链接 [[file]] ───
  { ok(markdownToPlainWithMap('see [[My Note]] here').plain === 'see My Note here', '[[file]]→保留文件名') ? P() : F(); }

  // ─── Wiki链接 [[alias|file]] ───
  { ok(markdownToPlainWithMap('see [[Display|Real File]]').plain === 'see Display', '[[alias|file]]→保留alias') ? P() : F(); }

  // ─── Markdown链接 ───
  { ok(markdownToPlainWithMap('[click](https://url)').plain === 'click', '[text](url)→保留显示文本') ? P() : F(); }

  // ─── 行内公式 ───
  { ok(markdownToPlainWithMap('$E=mc^2$').plain === 'E=mc^2', '$...$→保留公式内容') ? P() : F(); }

  // ─── 块公式 ───
  { ok(markdownToPlainWithMap('$$x=1$$').plain === 'x=1', '$$...$$→保留内容') ? P() : F(); }

  // ─── 注释 ───
  { ok(markdownToPlainWithMap('visible %%hidden%% text').plain === 'visible  text', '%%注释%%→移除') ? P() : F(); }

  // ─── 未闭合注释 ───
  { ok(markdownToPlainWithMap('text %%unclosed').plain === 'text unclosed', '%%未闭合→跳过%%') ? P() : F(); }

  // ─── HTML标签 ───
  { ok(markdownToPlainWithMap('text <mark>highlighted</mark> text').plain === 'text highlighted text', '<tag>→移除标签保留内容') ? P() : F(); }

  // ─── Callout前缀 ───
  { ok(markdownToPlainWithMap('> [!note] Title\n> Content').plain === '[!note] Title\nContent', 'Callout前缀>移除') ? P() : F(); }

  // ─── 无序列表 ───
  { ok(markdownToPlainWithMap('- item1\n- item2').plain === 'item1\nitem2', '无序列表→移除标记') ? P() : F(); }
  { ok(markdownToPlainWithMap('* item').plain === 'item', '* 列表→移除标记') ? P() : F(); }
  { ok(markdownToPlainWithMap('+ item').plain === 'item', '+ 列表→移除标记') ? P() : F(); }

  // ─── 有序列表 ───
  { ok(markdownToPlainWithMap('1. first\n2. second').plain === 'first\nsecond', '有序列表→移除数字标记') ? P() : F(); }

  // ─── 任务列表 ───
  { ok(markdownToPlainWithMap('- [ ] todo\n- [x] done').plain === 'todo\ndone', '任务列表→移除复选框') ? P() : F(); }

  // ─── 标题 ───
  { ok(markdownToPlainWithMap('# Title\nContent').plain === 'Title\nContent', '#标题→移除#号') ? P() : F(); }
  { ok(markdownToPlainWithMap('### Deep heading').plain === 'Deep heading', '### 多级标题→移除#号') ? P() : F(); }

  // ─── 代码围栏 ───
  {
    const src = '```python\nprint("hi")\nx = 1\n```';
    ok(markdownToPlainWithMap(src).plain === 'print("hi")\nx = 1', '代码围栏→保留内部代码') ? P() : F();
  }

  // ─── 偏移映射正确性 ───
  {
    const src = '**bold** and *italic*';
    const { plain, map } = markdownToPlainWithMap(src);
    ok(map[0] === 2, 'bold[0]映射到src[2]') ? P() : F();
    ok(map[3] === 5, 'bold[3]映射到src[5]') ? P() : F();
    ok(plain.indexOf(' and ') >= 0, 'and出现在plain中') ? P() : F();
  }

  // ─── 混合复杂场景 ───
  { ok(markdownToPlainWithMap('- **bold** and `code` [[link|alias]]').plain === 'bold and code link', '混合标记→正确转换') ? P() : F(); }

  // ─── 无闭合标记降级 ───
  { ok(markdownToPlainWithMap('**unclosed bold').plain === '**unclosed bold', '未闭合**→保留原字符') ? P() : F(); }

  // ─── 普通星号不误吞 ───
  { ok(markdownToPlainWithMap('a * b = c').plain === 'a * b = c', '普通星号不误吞') ? P() : F(); }

  // ─── 多行文档 ───
  {
    const src = '# Title\n\nParagraph with **bold**.\n\n- item1\n- item2';
    const { plain } = markdownToPlainWithMap(src);
    ok(plain.includes('Title'), '多行文档包含标题') ? P() : F();
    ok(plain.includes('bold'), '多行文档包含粗体内容') ? P() : F();
    ok(plain.includes('item1'), '多行文档包含列表项') ? P() : F();
  }

  console.log(`\n📊 markdownToPlainWithMap: ${p} passed, ${f} failed\n`);
  return { passed: p, failed: f };
}

async function run() {
  console.log('🧪 Markdown Plain Conversion Tests');
  const { passed, failed } = await testMarkdownToPlainWithMap();
  console.log(`📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
