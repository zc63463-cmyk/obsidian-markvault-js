/**
 * tokenizer.ts — CJK+English 混合分词器
 *
 * 策略：
 * - CJK (CJK Unified Ideographs): bigram 切片 + 单字回退，bigram 命中权重 ×2
 * - 英文单词：按空格/标点/数字边界分词，转小写
 * - UUID 前缀：自动提取 8 位及以上十六进制串（带连字符），也做小写匹配
 * - 数字：保留为 token（方便搜索页码、章节号等）
 *
 * 无外部依赖，纯函数，可独立测试。
 */

/** CJK Unicode 范围（仅表意文字，不含标点） */
const CJK_RANGES: readonly [number, number][] = [
  [0x4E00, 0x9FFF],   // CJK Unified Ideographs
  [0x3400, 0x4DBF],   // CJK Unified Ideographs Extension A
  [0xF900, 0xFAFF],   // CJK Compatibility Ideographs
  [0x20000, 0x2A6DF], // CJK Extension B
  [0x2A700, 0x2B73F], // CJK Extension C
];

export function isCJK(codePoint: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return true;
  }
  return false;
}

/**
 * 将文本切分为搜索 token 数组。
 *
 * @param text 原始文本
 * @returns 唯一 token 数组（去重，保序）
 */
export function tokenize(text: string): string[] {
  if (!text) return [];

  const chars = [...text];               // 正确拆分 Unicode 码点
  const tokens: string[] = [];
  const seen = new Set<string>();

  const addToken = (t: string) => {
    const lower = t.toLowerCase();
    if (lower.length >= 1 && !seen.has(lower)) {
      seen.add(lower);
      tokens.push(lower);
    }
  };

  let cjkBuffer: string[] = [];
  let wordBuffer: string[] = [];

  const flushCjk = () => {
    if (cjkBuffer.length === 0) return;
    // Bigram: 每两个连续字符
    for (let i = 0; i < cjkBuffer.length - 1; i++) {
      addToken(cjkBuffer[i] + cjkBuffer[i + 1]);
    }
    // 单字（回退匹配）
    for (const ch of cjkBuffer) {
      addToken(ch);
    }
    cjkBuffer = [];
  };

  const flushWord = () => {
    if (wordBuffer.length === 0) return;
    const word = wordBuffer.join('');
    if (word.length >= 1) addToken(word);
    wordBuffer = [];
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const cp = ch.codePointAt(0) ?? 0;

    if (isCJK(cp)) {
      flushWord();
      cjkBuffer.push(ch);
    } else if (isAlpha(cp) || cp === 0x2D /* '-' */) {
      // 连字符仅在前导字符为字母/数字时保留（UUID、复合词），纯连字符不产生 token
      flushCjk();
      if (cp === 0x2D && wordBuffer.length === 0) {
        // 连字符开头 → 忽略，不加入 wordBuffer
      } else {
        wordBuffer.push(ch);
      }
    } else if (isDigit(cp)) {
      // 数字也算作单词的一部分（处理 "ch12" 这样的混合）
      flushCjk();
      wordBuffer.push(ch);
    } else {
      // 标点/空格/其他 → 边界
      flushCjk();
      flushWord();
    }
  }
  flushCjk();
  flushWord();

  return tokens;
}

/**
 * tokenize 的便捷别名（语义更明确）。
 * 当调用方是分词用户查询时使用。
 */
export function tokenizeQuery(query: string): string[] {
  return tokenize(query);
}

/**
 * 找出文本中匹配指定 token 的片段。
 *
 * @param text   原始文本
 * @param tokens 目标 token 列表（小写）
 * @param maxLen 返回片段的最大长度
 * @returns 匹配的文本片段（从第一次命中位置截取），无命中返回空字符串
 */
export function findMatchSnippet(text: string, tokens: string[], maxLen: number = 80): string {
  if (!text || tokens.length === 0) return '';
  const lower = text.toLowerCase();

  let firstIdx = Infinity;
  for (const t of tokens) {
    const idx = lower.indexOf(t);
    if (idx !== -1 && idx < firstIdx) {
      firstIdx = idx;
    }
  }

  if (firstIdx === Infinity) return '';

  const start = Math.max(0, firstIdx - 10);
  const end = Math.min(text.length, firstIdx + maxLen);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = '…' + snippet;
  if (end < text.length) snippet = snippet + '…';
  return snippet;
}

// ─── 辅助 ──────────────────────────────────────────────

function isAlpha(cp: number): boolean {
  return (cp >= 0x41 && cp <= 0x5A)  /* A-Z */
      || (cp >= 0x61 && cp <= 0x7A)  /* a-z */
      || cp === 0x5F;                 /* _ */
}

function isDigit(cp: number): boolean {
  return cp >= 0x30 && cp <= 0x39;   /* 0-9 */
}
