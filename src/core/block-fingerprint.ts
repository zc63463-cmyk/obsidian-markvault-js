/**
 * Block / Span 指纹定位与恢复
 *
 * 目标：解决 Block/Span 锚点只依赖行号的问题。
 * 通过存储目标内容的稳定指纹，在锚点与目标块发生相对移动后，
 * 仍能在附近找回正确目标。
 */

const SIGNATURE_WINDOW = 30; // 搜索窗口 +/- 行

/**
 * 计算文本的归一化签名
 * - 压缩空白
 * - 取前 120 字符
 * - djb2 32-bit hash
 */
export function computeSignature(text: string): string {
  const normalized = text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  if (normalized.length === 0) return '';

  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash) + normalized.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

/**
 * 根据行内容猜测块类型
 */
export function detectBlockTypeAtLine(lines: string[], lineIdx: number): string {
  if (lineIdx < 0 || lineIdx >= lines.length) return 'paragraph';
  const line = lines[lineIdx];
  const trimmed = line.trim();

  // 代码块
  if (trimmed.startsWith('```')) return 'code-block';
  // 公式块
  if (trimmed === '$$' || trimmed === '$$$') return 'math-block';
  // Callout
  if (/^>\s*\[!/.test(trimmed)) return 'callout';
  // 表格
  if (/^\|.*\|$/.test(trimmed)) return 'table';
  // 图片
  if (/^!\[/.test(trimmed)) return 'image';
  // 嵌入
  if (/^!\[\[/.test(trimmed)) return 'embed';
  // 标题
  if (/^#{1,6}\s+/.test(trimmed)) return 'heading';
  // 列表
  if (/^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) return 'list';

  return 'paragraph';
}

/**
 * 提取块的“代表性内容”用于生成指纹
 * 对代码/公式块会越过围栏取第一行内容；对表格取前两行。
 */
function getBlockContentSnapshot(lines: string[], targetLine: number, blockType?: string): string {
  if (targetLine < 0 || targetLine >= lines.length) return '';

  const parts: string[] = [];
  let current = targetLine;
  const type = blockType || detectBlockTypeAtLine(lines, targetLine);

  if (type === 'code-block' || type === 'math-block') {
    // 跳过起始围栏，取块内第一行有意义内容
    current++; // 从目标行的下一行开始
    while (current < lines.length) {
      const trimmed = lines[current].trim();
      if (
        trimmed.startsWith('```') ||
        trimmed === '$$' ||
        trimmed === '$$$'
      ) {
        break;
      }
      if (trimmed.length > 0) {
        parts.push(trimmed);
        if (parts.length >= 2) break;
      }
      current++;
    }
  } else if (type === 'table') {
    // 表格取表头和分隔行
    for (let i = 0; i < 2 && current + i < lines.length; i++) {
      parts.push(lines[current + i].trim());
    }
  } else if (type === 'callout') {
    // Callout 取第一行和接下来一行非空内容
    for (let i = 0; current + i < lines.length && i < 3; i++) {
      const trimmed = lines[current + i].trim();
      if (trimmed.length === 0) continue;
      parts.push(trimmed);
    }
  } else {
    // 段落/图片/嵌入/列表：取第一行即可
    parts.push(lines[current].trim());
  }

  return parts.join(' | ');
}

/**
 * 为 block 标注计算目标块指纹
 */
export function computeBlockSignature(
  lines: string[],
  targetLine: number,
  blockType?: string,
): string {
  return computeSignature(getBlockContentSnapshot(lines, targetLine, blockType));
}

/**
 * 为 span 标注计算文本指纹
 */
export function computeSpanSignature(text: string): string {
  return computeSignature(text);
}

/**
 * 在目标行附近搜索匹配的块
 *
 * @param lines 文档行数组
 * @param expectedType 期望块类型
 * @param signature 目标指纹
 * @param preferredLine 首选行号（通常是当前 targetLine）
 * @param searchWindow 搜索半径，默认 SIGNATURE_WINDOW
 * @returns 匹配到的行号，未找到返回 null
 */
export function findBlockLineBySignature(
  lines: string[],
  expectedType: string,
  signature: string,
  preferredLine: number,
  searchWindow: number = SIGNATURE_WINDOW,
): number | null {
  if (!signature) return null;

  let bestLine: number | null = null;
  let bestDist = Infinity;

  const start = Math.max(0, preferredLine - searchWindow);
  const end = Math.min(lines.length - 1, preferredLine + searchWindow);

  for (let i = start; i <= end; i++) {
    const type = detectBlockTypeAtLine(lines, i);
    if (type !== expectedType && expectedType !== 'paragraph') continue;

    const candidateSig = computeBlockSignature(lines, i, type);
    if (candidateSig === signature) {
      const dist = Math.abs(i - preferredLine);
      if (dist < bestDist) {
        bestDist = dist;
        bestLine = i;
      }
    }
  }

  return bestLine;
}

/**
 * 在目标区域附近搜索匹配的 span 文本
 *
 * P0-4 修复：从候选行开始累积多行文本计算指纹，
 * 因为 targetHash 是多行文本的指纹（computeSpanSignature），
 * 逐行单行指纹比较永远不匹配多行 span。
 *
 * @param lines 文档行数组
 * @param signature 目标 span 文本指纹（多行指纹）
 * @param preferredLine 首选起始行
 * @param searchWindow 搜索半径
 * @returns 匹配到的起始行号，未找到返回 null
 */
export function findSpanLineBySignature(
  lines: string[],
  signature: string,
  preferredLine: number,
  searchWindow: number = SIGNATURE_WINDOW,
): number | null {
  if (!signature) return null;

  let bestLine: number | null = null;
  let bestDist = Infinity;

  const start = Math.max(0, preferredLine - searchWindow);
  const end = Math.min(lines.length - 1, preferredLine + searchWindow);

  for (let i = start; i <= end; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    if (/^%%markvault(-span)?:/.test(line)) continue;

    // 从此行开始累积多行文本，最多尝试 20 行
    let accumulated = '';
    for (let j = i; j < Math.min(lines.length, i + 20); j++) {
      const trimmed = lines[j].trim();
      if (/^%%markvault(-span)?:/.test(trimmed)) break;
      if (trimmed.length === 0 && accumulated.length > 0) {
        accumulated += ' ';
        continue;
      }
      accumulated += (accumulated ? ' ' : '') + trimmed;

      const candidateSig = computeSpanSignature(accumulated);
      if (candidateSig === signature) {
        const dist = Math.abs(i - preferredLine);
        if (dist < bestDist) {
          bestDist = dist;
          bestLine = i;
        }
        break; // 找到匹配，无需继续累积
      }
    }
  }

  return bestLine;
}
