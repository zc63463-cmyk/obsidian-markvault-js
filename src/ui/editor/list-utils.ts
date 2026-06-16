/**
 * 列表工具函数（从 context-menu.ts 提取）
 *
 * 纯字符串/数组操作函数，无 Obsidian 运行时依赖，
 * 可独立进行单元测试。
 */

/**
 * 如果一行是列表项，返回它的标记前缀（含前导空格和标记后的空格）
 * 以及用于子内容的缩进空格串。
 */
export function getListItemPrefix(line: string): { marker: string; childIndent: string } | null {
  const m = line.match(/^(\s*)((?:[-*+])|(?:\d+\.))\s/);
  if (!m) return null;
  const leading = m[1];
  const markerBody = m[2] + ' ';
  return { marker: m[0], childIndent: leading + ' '.repeat(markerBody.length) };
}

/**
 * 为列表项目标计算 start / end 锚点应该使用的缩进。
 */
export function getBlockAnchorPrefixesForListItem(
  lines: string[],
  targetLine: number,
): { startAnchorPrefix: string; endAnchorPrefix: string } {
  const targetLineText = lines[targetLine] ?? '';
  const targetListPrefix = getListItemPrefix(targetLineText);
  if (!targetListPrefix) return { startAnchorPrefix: '', endAnchorPrefix: '' };

  const targetLeadingSpaces = (targetLineText.match(/^(\s*)/)?.[1] ?? '').length;
  let startAnchorPrefix = '';

  for (let i = targetLine - 1; i >= 0; i--) {
    const prevPrefix = getListItemPrefix(lines[i]);
    if (!prevPrefix) continue;
    const prevLeadingSpaces = (lines[i].match(/^(\s*)/)?.[1] ?? '').length;
    if (prevLeadingSpaces <= targetLeadingSpaces) {
      startAnchorPrefix = prevPrefix.childIndent;
      break;
    }
  }

  return { startAnchorPrefix, endAnchorPrefix: targetListPrefix.childIndent };
}

/**
 * 将绝对偏移量转换为 {line, ch} 坐标。
 *
 * BUG-15: 当前实现使用 '\\n' 字面量（反斜杠n）而非 '\n'（换行符），
 * 导致在真实换行符的 markdown 内容中无法正确分割行。
 * 修复：将 split('\\n') 和 lastIndexOf('\\n') 改为 split('\n') 和 lastIndexOf('\n')。
 */
export function offsetToLineCh(content: string, offset: number): { line: number; ch: number } {
  const before = content.substring(0, offset);
  const line = before.split('\n').length - 1;
  const lastNewline = before.lastIndexOf('\n');
  const ch = lastNewline === -1 ? offset : offset - lastNewline - 1;
  return { line, ch };
}

/**
 * 如果 region 起点落在列表项的行首，将锚点后移到 marker 之后（起点）
 */
export function adjustRegionStartOffsetForListItem(content: string, offset: number): number {
  const { line, ch } = offsetToLineCh(content, offset);
  const lines = content.split('\n');
  const prefix = getListItemPrefix(lines[line] ?? '');
  if (prefix && ch === 0) {
    return offset + prefix.marker.length;
  }
  return offset;
}

/**
 * 如果 region 终点落在列表项的行首，将锚点前移到上一行末尾（终点）
 */
export function adjustRegionEndOffsetForListItem(content: string, offset: number): number {
  const { line, ch } = offsetToLineCh(content, offset);
  const lines = content.split('\n');
  const prefix = getListItemPrefix(lines[line] ?? '');
  if (prefix && ch === 0 && offset > 0) {
    return offset - 1;
  }
  return offset;
}
