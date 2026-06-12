/**
 * Markdown 上下文边界扫描器
 *
 * 在创建标注时，扫描选中文本中的 Markdown 特殊语法区域，
 * 避免将 <mark> 标签包裹到公式/代码/图片等特殊内容上，
 * 从而破坏 Obsidian 的渲染。
 *
 * 使用场景：
 * - 选中 "根据 $E=mc^2$ 可知" 时，$E=mc^2$ 是行内公式，
 *   不应被 <mark> 包裹，需要拆分为独立的文本段
 * - 选中整个 $$...$$ 公式块时，无法用行内标注包裹，
 *   需要降级为块级锚点标注（Track B）
 */

/** Markdown 上下文类型 */
export type MdContextType =
  | 'text'           // 普通文本，可以安全包裹 <mark>
  | 'inline-math'    // 行内公式 $...$
  | 'block-math'     // 块级公式 $$...$$
  | 'inline-code'    // 行内代码 `...`
  | 'block-code'     // 代码块 ```...```
  | 'image'          // 图片 ![alt](url)
  | 'embed'          // 嵌入 ![[note]]
  | 'wiki-link'      // 双链 [[note]]
  | 'formatting';    // 其他格式标记 (粗体/斜体/删除线等)

/** 扫描出的上下文片段 */
export interface ContextSegment {
  /** 片段类型 */
  type: MdContextType;
  /** 原始文本内容 */
  content: string;
  /** 在选区中的起始偏移 */
  startOffset: number;
  /** 在选区中的结束偏移 */
  endOffset: number;
}

/** 扫描结果摘要 */
export interface ScanResult {
  /** 拆分后的片段列表 */
  segments: ContextSegment[];
  /** 是否包含特殊内容 */
  hasSpecialContent: boolean;
  /** 是否全部为特殊内容（无法用行内标注） */
  isAllSpecial: boolean;
  /** 可以安全包裹的文本片段 */
  textSegments: ContextSegment[];
  /** 特殊内容片段 */
  specialSegments: ContextSegment[];
}

// ─── 正则模式（按优先级排序） ──────────────────────────────

/**
 * 特殊语法正则列表
 *
 * 优先级规则：
 * 1. block-code 优先于 block-math（``` 比 $$ 更常见且更不可破坏）
 * 2. block-math 优先于 inline-math（$$ 优先于 $）
 * 3. inline-math 优先于 inline-code（$ 更容易误匹配）
 * 4. image/embed 优先于 wiki-link（![ 包含 [）
 *
 * 每个正则都使用 'g' 标志，支持多次 exec
 */
const CONTEXT_PATTERNS: readonly [MdContextType, RegExp][] = [
  // 代码块: ```lang\n...\n```  (可能跨多行)
  ['block-code', /```[\s\S]*?```/g],

  // 块级公式: $$...$$  (可能跨多行)
  ['block-math', /\$\$[\s\S]*?\$\$/g],

  // 行内公式: $...$  (不跨行，不能包含空 $)
  // 注意：$前后不能是字母数字，避免匹配 "5$10" 之类的价格
  // 匹配 $...$ 且内部不含 $ 的内容
  ['inline-math', /(?<![a-zA-Z0-9])\$(?!\$)([^\$\n]+?)\$(?![a-zA-Z0-9])/g],

  // 行内代码: `...`  (不跨行)
  ['inline-code', /``[^`]*``|`[^`]+?`/g],

  // 图片: ![alt](url) 或 ![alt](url "title")
  ['image', /!\[[^\]]*\]\([^)]+\)/g],

  // 嵌入: ![[note]] 或 ![[note|alias]]
  ['embed', /!\[\[[^\]]+\]\]/g],

  // 双链: [[note]] 或 [[note|alias]] 或 [[note#heading]]
  ['wiki-link', /\[\[[^\]]+\]\]/g],

  // 格式标记: **bold** / *italic* / ~~strikethrough~~ / ==highlight==
  ['formatting', /(\*\*[\s\S]*?\*\*|\*[^*]+?\*|~~[\s\S]*?~~|==[\s\S]*?==)/g],
] as const;

// ─── 核心扫描函数 ──────────────────────────────────────────

/**
 * 扫描选中文本，识别并拆分 Markdown 特殊上下文区域
 *
 * @param selection 用户在编辑器中选中的文本
 * @returns 扫描结果，包含片段列表和摘要信息
 *
 * @example
 * ```ts
 * const result = scanMarkdownContexts('根据 $E=mc^2$ 可知');
 * // result.segments = [
 * //   { type: 'text', content: '根据 ', startOffset: 0, endOffset: 3 },
 * //   { type: 'inline-math', content: '$E=mc^2$', startOffset: 3, endOffset: 11 },
 * //   { type: 'text', content: ' 可知', startOffset: 11, endOffset: 14 },
 * // ]
 * // result.hasSpecialContent = true
 * // result.isAllSpecial = false
 * ```
 */
export function scanMarkdownContexts(selection: string): ScanResult {
  const segments: ContextSegment[] = [];

  if (!selection || selection.length === 0) {
    return {
      segments: [],
      hasSpecialContent: false,
      isAllSpecial: false,
      textSegments: [],
      specialSegments: [],
    };
  }

  // 标记已被匹配的字符位置（避免重叠匹配）
  const occupied = new Uint8Array(selection.length);

  // 按优先级依次匹配各种特殊语法
  for (const [type, regex] of CONTEXT_PATTERNS) {
    // 重置正则的 lastIndex（因为使用了 'g' 标志）
    const pattern = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(selection)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      // 检查此区域是否已被更高优先级的匹配占据
      let isOverlapped = false;
      for (let i = start; i < end; i++) {
        if (occupied[i]) {
          isOverlapped = true;
          break;
        }
      }

      if (isOverlapped) continue;

      // 标记此区域为已占据
      for (let i = start; i < end; i++) {
        occupied[i] = 1;
      }

      segments.push({
        type,
        content: match[0],
        startOffset: start,
        endOffset: end,
      });
    }
  }

  // 按 startOffset 排序
  segments.sort((a, b) => a.startOffset - b.startOffset);

  // 填充剩余的 text 区域
  const result: ContextSegment[] = [];
  let cursor = 0;

  for (const seg of segments) {
    // 如果当前游标到片段起始之间有间隙，填充为 text
    if (seg.startOffset > cursor) {
      result.push({
        type: 'text',
        content: selection.slice(cursor, seg.startOffset),
        startOffset: cursor,
        endOffset: seg.startOffset,
      });
    }
    result.push(seg);
    cursor = seg.endOffset;
  }

  // 处理末尾的 text 区域
  if (cursor < selection.length) {
    result.push({
      type: 'text',
      content: selection.slice(cursor),
      startOffset: cursor,
      endOffset: selection.length,
    });
  }

  // 如果没有任何特殊内容匹配，整个选区是一个 text 片段
  if (result.length === 0) {
    result.push({
      type: 'text',
      content: selection,
      startOffset: 0,
      endOffset: selection.length,
    });
  }

  // 计算摘要
  const textSegments = result.filter(s => s.type === 'text');
  const specialSegments = result.filter(s => s.type !== 'text');
  const hasSpecialContent = specialSegments.length > 0;
  const isAllSpecial = textSegments.length === 0 || textSegments.every(s => s.content.trim().length === 0);

  return {
    segments: result,
    hasSpecialContent,
    isAllSpecial,
    textSegments,
    specialSegments,
  };
}

// ─── 块级检测辅助函数 ──────────────────────────────────────

/** 块级元素信息 */
export interface BlockInfo {
  /** 块类型 */
  type: 'math-block' | 'code-block' | 'image' | 'embed' | 'callout' | 'table' | 'paragraph';
  /** 块起始行号 */
  startLine: number;
  /** 块结束行号（含） */
  endLine: number;
  /** 块的原始文本内容 */
  content: string;
}

/**
 * 检测编辑器中光标所在行是否属于块级元素
 * 用于无选中文本时的"标注此块"功能
 *
 * @param editorContent 编辑器全文内容
 * @param cursorLine 光标所在行号（0-based）
 * @returns 块级元素信息，如果不是块级元素则返回 null
 */
export function detectBlockAtLine(editorContent: string, cursorLine: number): BlockInfo | null {
  const lines = editorContent.split('\n');
  if (cursorLine < 0 || cursorLine >= lines.length) return null;

  const line = lines[cursorLine];

  // 块级公式 $$...$$
  // 🔧 v2.0 修复：如果光标在 $$ 块内部（内容行），也能检测到
  if (line.trimStart().startsWith('$$')) {
    return findBlockRange(lines, cursorLine, l => l.trimStart().startsWith('$$'), 'math-block');
  }
  // 检查光标是否在 $$ 块的内容行中
  const mathBlock = findEnclosingBlock(lines, cursorLine, l => l.trimStart().startsWith('$$'), 'math-block');
  if (mathBlock) {
    return mathBlock;
  }

  // 代码块 ```...```
  if (line.trimStart().startsWith('```')) {
    return findBlockRange(lines, cursorLine, l => l.trimStart().startsWith('```'), 'code-block');
  }
  // 检查光标是否在 ``` 块的内容行中
  const codeBlock = findEnclosingBlock(lines, cursorLine, l => l.trimStart().startsWith('```'), 'code-block');
  if (codeBlock) {
    return codeBlock;
  }

  // 图片行 ![alt](url)
  if (line.match(/^\s*!\[[^\]]*\]\([^)]+\)/)) {
    return {
      type: 'image',
      startLine: cursorLine,
      endLine: cursorLine,
      content: line,
    };
  }

  // 嵌入行 ![[note]]
  if (line.match(/^\s*!\[\[[^\]]+\]\]/)) {
    return {
      type: 'embed',
      startLine: cursorLine,
      endLine: cursorLine,
      content: line,
    };
  }

  // Callout > [!type]
  if (line.match(/^\s*>\s*\[!/)) {
    return findCalloutRange(lines, cursorLine);
  }

  // 表格 | header |
  if (line.match(/^\s*\|/)) {
    return findTableRange(lines, cursorLine);
  }

  // 🆕 v2.0: 行内公式 — 如果整行主要是公式内容
  // 匹配包含 $...$ 的行（行内公式混合普通文本的情况）
  // 🔧 v2.0 修复：仅当行主要是公式时返回，否则不应被当作块级元素
  // 避免普通文本行因为有 $ 符号就被误判
  if (line.includes('$') && !line.trimStart().startsWith('$$')) {
    const inlineMathRegex = /(?<![a-zA-Z0-9])\$(?!\$)([^\$\n]+?)\$(?![a-zA-Z0-9])/g;
    let mathCount = 0;
    let mathLen = 0;
    let m: RegExpExecArray | null;
    while ((m = inlineMathRegex.exec(line)) !== null) {
      mathCount++;
      mathLen += m[0].length;
    }
    // 只有当公式内容占行长度 30% 以上时才认为是"公式行"
    if (mathCount > 0 && mathLen / line.trim().length > 0.3) {
      return {
        type: 'paragraph',
        startLine: cursorLine,
        endLine: cursorLine,
        content: line,
      };
    }
  }

  // 🆕 v2.0: 列表项（- / * / 1.）— 列表项也是可标注的块
  if (line.match(/^\s*[-*]\s/) || line.match(/^\s*\d+\.\s/)) {
    return {
      type: 'paragraph',
      startLine: cursorLine,
      endLine: cursorLine,
      content: line,
    };
  }

  // 🆕 v2.0: 标题行 — 可标注的块
  if (line.match(/^#{1,6}\s/)) {
    return {
      type: 'paragraph',
      startLine: cursorLine,
      endLine: cursorLine,
      content: line,
    };
  }

  // 🔧 v2.0 修复：移除"任何非空行都可以作为段落标注"的兜底策略
  // 原来的兜底会导致右键菜单在普通文本上也显示"Annotate this block"，
  // 让用户误以为检测功能有问题。
  // 对于普通文本行，返回 null，让右键菜单不显示块级标注选项。

  return null;
}

/**
 * 查找配对块的范围（公式块、代码块）
 * 先从当前行向上查找起始分隔符，再向下查找结束分隔符
 */
function findBlockRange(
  lines: string[],
  startLine: number,
  delimiterTest: (line: string) => boolean,
  blockType: BlockInfo['type'],
): BlockInfo {
  // 向上查找起始分隔符行
  let beginLine = startLine;
  for (let i = startLine; i >= 0; i--) {
    if (delimiterTest(lines[i])) {
      beginLine = i;
      break;
    }
  }

  // 从起始行向下查找结束分隔符行
  let endLine = beginLine;
  let foundClose = false;
  for (let i = beginLine + 1; i < lines.length; i++) {
    if (delimiterTest(lines[i])) {
      endLine = i;
      foundClose = true;
      break;
    }
    endLine = i;
  }

  // 如果没有找到闭合分隔符，块延伸到文件末尾
  if (!foundClose) {
    endLine = lines.length - 1;
  }

  const content = lines.slice(beginLine, endLine + 1).join('\n');
  return { type: blockType, startLine: beginLine, endLine, content };
}

/**
 * 检查光标是否在某类块的内容行中（向上查找起始分隔符，向下查找结束分隔符）
 * 如果光标在两个分隔符之间，返回这个块的信息
 */
function findEnclosingBlock(
  lines: string[],
  cursorLine: number,
  delimiterTest: (line: string) => boolean,
  blockType: BlockInfo['type'],
): BlockInfo | null {
  // 向上查找最近的起始分隔符
  let beginLine = -1;
  for (let i = cursorLine - 1; i >= 0; i--) {
    if (delimiterTest(lines[i])) {
      beginLine = i;
      break;
    }
  }

  if (beginLine === -1) return null; // 没有找到起始分隔符

  // 从起始行向下查找结束分隔符
  let endLine = -1;
  for (let i = beginLine + 1; i < lines.length; i++) {
    if (delimiterTest(lines[i])) {
      endLine = i;
      break;
    }
  }

  if (endLine === -1) return null; // 没有闭合，不是一个完整的块

  // 验证光标确实在块内部（不含分隔符行本身）
  if (cursorLine > beginLine && cursorLine < endLine) {
    const content = lines.slice(beginLine, endLine + 1).join('\n');
    return { type: blockType, startLine: beginLine, endLine, content };
  }

  return null;
}

/**
 * 查找 callout 的范围（连续的 > 开头行）
 */
function findCalloutRange(lines: string[], startLine: number): BlockInfo {
  let beginLine = startLine;
  let endLine = startLine;

  // 向上查找 callout 起始
  for (let i = startLine; i >= 0; i--) {
    if (lines[i].startsWith('>')) {
      beginLine = i;
    } else {
      break;
    }
  }

  // 向下查找 callout 结束
  for (let i = startLine; i < lines.length; i++) {
    if (lines[i].startsWith('>')) {
      endLine = i;
    } else {
      break;
    }
  }

  const content = lines.slice(beginLine, endLine + 1).join('\n');
  return { type: 'callout', startLine: beginLine, endLine, content };
}

/**
 * 查找表格的范围（连续的 | 开头行，中间可能有分隔行 |---|---|）
 */
function findTableRange(lines: string[], startLine: number): BlockInfo {
  let beginLine = startLine;
  let endLine = startLine;

  for (let i = startLine; i >= 0; i--) {
    if (lines[i].match(/^\s*\|/)) {
      beginLine = i;
    } else {
      break;
    }
  }

  for (let i = startLine; i < lines.length; i++) {
    if (lines[i].match(/^\s*\|/)) {
      endLine = i;
    } else {
      break;
    }
  }

  const content = lines.slice(beginLine, endLine + 1).join('\n');
  return { type: 'table', startLine: beginLine, endLine, content };
}
