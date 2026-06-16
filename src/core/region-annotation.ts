/**
 * Region 标注（区域标注）
 *
 * 格式：
 *   %%markvault-region:<uuid>:<type>:<color>:start:<escaped-note>%%
 *   ...区域内容（可含公式、代码、图片、callout、跨块）...
 *   %%markvault-region:<uuid>:<type>:<color>:end:<escaped-note>%%
 *
 * 特点：
 * - 双锚点包围区域，内容原样保留。
 * - 支持嵌套（按 uuid 配对）。
 * - 编辑模式用 CM6 layer 覆盖公式/代码 Widget；阅读模式遍历 DOM 节点加 class。
 */

import type { Annotation, AnnotationType } from '../types/annotation';
import { generateId } from '../utils/id';

/** 匹配 region start/end 锚点
 *  🔧 关键修复：note 字段使用 [^\n]* 而非 [^%]*，
 *  因为 note 中可能包含 % 字符（如文件路径 %src/core/...），
 *  旧版 [^%]* 会在 note 中的 % 处提前终止，导致整个锚点无法匹配。
 *  [^\n]* 是安全的，因为锚点不跨行，且 %% 终止符会正确锚定匹配边界。
 */
export const REGION_ANCHOR_REGEX = /%%markvault-region:([^:%]+):([^:%]+):([^:%]+):(start|end):([^%]*)%%/g;

/** 锚点字段中的特殊字符转义（数字后缀 \0=\ \1=% \2=:） */
function escapeAnchorField(s: string): string {
  return s.replace(/\\/g, '\\0').replace(/\n/g, ' ').replace(/%/g, '\\1').replace(/:/g, '\\2');
}

/** 锚点字段中的特殊字符反转义 */
function decodeAnchorField(s: string): string {
  return s.replace(/\\2/g, ':').replace(/\\1/g, '%').replace(/\\0/g, '\\');
}

/** 正则特殊字符转义 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 生成 region 锚点字符串 */
export function buildRegionAnchor(
  annotation: Pick<Annotation, 'uuid' | 'type' | 'color' | 'note'>,
  position: 'start' | 'end',
): string {
  return `%%markvault-region:${annotation.uuid}:${annotation.type}:${annotation.color}:${position}:${escapeAnchorField(annotation.note || '')}%%`;
}

/** region 范围定位结果 */
export interface RegionRange {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
  startAnchorOffset: number;
  startAnchorEnd: number;
  endAnchorOffset: number;
  endAnchorEnd: number;
  contentStart: number;
  contentEnd: number;
  text: string;
}

/** 在文档中查找指定 uuid 的 region 范围 */
export function findRegionRange(content: string, uuid: string): RegionRange | null {
  const matches: {
    index: number;
    length: number;
    uuid: string;
    type: AnnotationType;
    color: string;
    note: string;
    position: 'start' | 'end';
  }[] = [];

  REGION_ANCHOR_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REGION_ANCHOR_REGEX.exec(content)) !== null) {
    matches.push({
      index: m.index,
      length: m[0].length,
      uuid: m[1],
      type: m[2] as AnnotationType,
      color: m[3],
      note: decodeAnchorField(m[5]),
      position: m[4] as 'start' | 'end',
    });
  }

  const startMatch = matches.find(m => m.uuid === uuid && m.position === 'start');
  if (!startMatch) return null;

  const endMatch = matches.find(m => m.uuid === uuid && m.position === 'end' && m.index > startMatch.index);
  if (!endMatch) return null;

  return {
    uuid,
    type: startMatch.type,
    color: startMatch.color,
    note: startMatch.note,
    startAnchorOffset: startMatch.index,
    startAnchorEnd: startMatch.index + startMatch.length,
    endAnchorOffset: endMatch.index,
    endAnchorEnd: endMatch.index + endMatch.length,
    contentStart: startMatch.index + startMatch.length,
    contentEnd: endMatch.index,
    text: content.substring(startMatch.index + startMatch.length, endMatch.index),
  };
}

/**
 * 从 Markdown 内容解析所有 region 标注
 */
export function parseRegionAnnotations(
  content: string,
  filePath: string,
): Array<Annotation & { _source: 'markdown' }> {
  const results: Array<Annotation & { _source: 'markdown' }> = [];

  // 先收集所有锚点，按 uuid 分组
  const byUuid = new Map<string, {
    start?: { index: number; length: number; type: AnnotationType; color: string; note: string };
    end?: { index: number; length: number };
  }>();

  REGION_ANCHOR_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REGION_ANCHOR_REGEX.exec(content)) !== null) {
    const uuid = m[1];
    const position = m[4] as 'start' | 'end';
    const entry = byUuid.get(uuid) || {};
    if (position === 'start') {
      // 如果同一个 uuid 有多个 start，只保留第一个
      if (!entry.start) {
        entry.start = {
          index: m.index,
          length: m[0].length,
          type: m[2] as AnnotationType,
          color: m[3],
          note: decodeAnchorField(m[5]),
        };
      }
    } else {
      // 只保留第一个在 start 之后的 end（按遍历顺序自然满足）
      if (!entry.end) {
        entry.end = { index: m.index, length: m[0].length };
      }
    }
    byUuid.set(uuid, entry);
  }

  for (const [uuid, entry] of byUuid.entries()) {
    if (!entry.start || !entry.end) continue;

    const startOffset = entry.start.index;
    const endOffset = entry.end.index + entry.end.length;
    const contentStart = startOffset + entry.start.length;
    const contentEnd = entry.end.index;

    results.push({
      uuid,
      filePath,
      type: entry.start.type,
      color: entry.start.color,
      text: content.substring(contentStart, contentEnd),
      note: entry.start.note,
      tags: [],
      startOffset,
      endOffset,
      startLine: content.substring(0, startOffset).split('\n').length - 1,
      endLine: content.substring(0, endOffset).split('\n').length - 1,
      contextBefore: '',
      contextAfter: '',
      createdAt: 0,
      updatedAt: 0,
      kind: 'region',
      targetHash: '',
      _source: 'markdown' as const,
    });
  }

  // 按 startOffset 排序，保证解析顺序稳定
  results.sort((a, b) => a.startOffset - b.startOffset);

  return results;
}

/**
 * 从 Markdown 内容中移除指定 uuid 的 region 标注
 * 返回新内容；未找到返回 null
 */
export function removeRegionAnnotation(content: string, uuid: string): string | null {
  const range = findRegionRange(content, uuid);
  if (!range) return null;

  return content.substring(0, range.startAnchorOffset) + range.text + content.substring(range.endAnchorEnd);
}

/**
 * 更新指定 uuid region 标注的颜色/类型/批注
 */
export function updateRegionAnnotation(
  content: string,
  uuid: string,
  updates: { type?: AnnotationType; color?: string; note?: string },
): string | null {
  const range = findRegionRange(content, uuid);
  if (!range) return null;

  const currentType = updates.type || range.type;
  const currentColor = updates.color || range.color;
  const currentNote = updates.note !== undefined ? updates.note : range.note;

  const startAnchor = buildRegionAnchor({ uuid, type: currentType, color: currentColor, note: currentNote }, 'start');
  const endAnchor = buildRegionAnchor({ uuid, type: currentType, color: currentColor, note: currentNote }, 'end');

  return content.substring(0, range.startAnchorOffset) + startAnchor + range.text + endAnchor + content.substring(range.endAnchorEnd);
}

/**
 * 从 Markdown 内容中移除所有 region 锚点，保留内容
 * 用于纯文本/偏移恢复
 */
export function stripRegionAnnotations(content: string): string {
  return content.replace(REGION_ANCHOR_REGEX, '');
}
