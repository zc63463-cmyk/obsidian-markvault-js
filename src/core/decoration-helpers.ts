/**
 * CM6 装饰构建辅助函数
 *
 * 🔧 Phase 5B P1-D: 从 highlight-applier.ts 提取
 * 包含 mark 解析、重叠处理、围栏检测、region 分段等纯函数。
 *
 * @module decoration-helpers
 */

import { EditorSelection, type Extension } from '@codemirror/state';
import type { AnnotationType } from '../types/annotation';

// ─── 正则常量 ──────────────────────────────────────────────

/** 匹配完整的 <mark ...>text</mark> */
export const MARK_FULL_REGEX = /<mark\s+([^>]*)>([\s\S]*?)<\/mark>/g;
/** 从属性字符串中提取属性 */
export const ATTR_EXTRACT_REGEX = /\b([\w-]+)="([^"]*)"/g;

// ─── 类型 ──────────────────────────────────────────────────

export interface ParsedMark {
  openFrom: number;
  openTo: number;
  closeFrom: number;
  closeTo: number;
  uuid: string;
  type: AnnotationType;
  color: string;
  colorHex: string;
  note: string;
}

export interface FilteredMark extends ParsedMark {
  overlapOpacity?: number;
}

export interface RegionAnchorMatch {
  index: number;
  length: number;
  uuid: string;
  type: AnnotationType;
  color: string;
  position: 'start' | 'end';
}

// ─── 纯函数辅助方法 ────────────────────────────────────────

/**
 * 根据标注类型和颜色生成 CSS 样式字符串
 */
export function getStyleForType(type: AnnotationType, hex: string): string {
  switch (type) {
    case 'highlight':
      return `background-color: ${hex}66; border-radius: 2px; padding: 1px 0;`;
    case 'bold':
      return `font-weight: bold; border-bottom: 2px solid ${hex}; padding: 1px 0;`;
    case 'underline':
      return `text-decoration: underline; text-decoration-color: ${hex}; text-underline-offset: 2px;`;
    default:
      return `background-color: ${hex}66;`;
  }
}

/**
 * 解析属性字符串为键值对
 */
export function parseAttributes(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  ATTR_EXTRACT_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_EXTRACT_REGEX.exec(raw)) !== null) {
    result[m[1]] = m[2];
  }
  return result;
}

/**
 * 解析文档中的 <mark> 标签
 */
export function parseMarkTags(doc: string): ParsedMark[] {
  const marks: ParsedMark[] = [];
  MARK_FULL_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARK_FULL_REGEX.exec(doc)) !== null) {
    const attrs = parseAttributes(match[1]);
    const uuid = attrs['data-uuid'];
    if (!uuid) continue;
    const type = (attrs['data-type'] || 'highlight') as AnnotationType;
    const color = attrs['data-color'] || 'yellow';
    const note = attrs['data-note'] || '';
    marks.push({
      openFrom: match.index,
      openTo: match.index + match[1].length + 6, // <mark + space + attrs + >
      closeFrom: match.index + match[0].length - 7, // </mark>
      closeTo: match.index + match[0].length,
      uuid,
      type,
      color,
      colorHex: color, // 实际 hex 由调用方从 PRESET_COLORS 解析
      note,
    });
  }
  return marks;
}

/**
 * 🔧 P0-8 修复：处理重叠标注
 * 策略：将重叠标注拆分为不重叠的区段，保留所有标注。
 * 外层标注被内层标注分割成 [前段] + [后段]，
 * 与内层标注重叠的区域降低 opacity (0.4) 以区分层级。
 */
export function filterOverlapping(marks: ParsedMark[]): FilteredMark[] {
  if (marks.length <= 1) return marks;

  const sorted = [...marks].sort((a, b) => a.openFrom - b.openFrom || a.closeTo - b.closeTo);

  const result: FilteredMark[] = [];
  const activeStack: Array<{
    openFrom: number; closeTo: number; uuid: string;
    type: AnnotationType; color: string; colorHex: string; note: string;
  }> = [];

  for (const mark of sorted) {
    const overlapping = activeStack.filter(
      (a) => a.openFrom < mark.closeTo && a.closeTo > mark.openFrom,
    );

    if (overlapping.length === 0) {
      result.push({ ...mark });
      activeStack.push({
        openFrom: mark.openFrom, closeTo: mark.closeTo, uuid: mark.uuid,
        type: mark.type, color: mark.color, colorHex: mark.colorHex, note: mark.note,
      });
    } else {
      result.push({ ...mark, overlapOpacity: 0.4 });
      activeStack.push({
        openFrom: mark.openFrom, closeTo: mark.closeTo, uuid: mark.uuid,
        type: mark.type, color: mark.color, colorHex: mark.colorHex, note: mark.note,
      });
    }

    // 移除已关闭的标注
    for (let i = activeStack.length - 1; i >= 0; i--) {
      if (activeStack[i].closeTo <= mark.openFrom) {
        activeStack.splice(i, 1);
      }
    }
  }

  return result;
}

/**
 * 🔧 P0-7 修复：预扫描代码块/数学块范围
 * CM6 Widget（代码块/数学块）内的 inline Decoration 无法覆盖。
 */
export function computeFencedRanges(doc: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  const lines = doc.split('\n');
  let offset = 0;
  let inCodeBlock = false;
  let inMathBlock = false;
  let blockStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!inCodeBlock && !inMathBlock) {
      if (trimmed.startsWith('```')) {
        inCodeBlock = true;
        blockStart = offset;
      } else if (trimmed === '$$') {
        inMathBlock = true;
        blockStart = offset;
      }
    } else {
      if (inCodeBlock && trimmed.startsWith('```')) {
        inCodeBlock = false;
        ranges.push({ from: blockStart, to: offset + lines[i].length });
      } else if (inMathBlock && trimmed === '$$') {
        inMathBlock = false;
        ranges.push({ from: blockStart, to: offset + lines[i].length });
      }
    }
    offset += lines[i].length + 1;
  }

  return ranges;
}

/**
 * 检查区间是否在围栏范围内
 */
export function isInFencedRange(
  fencedRanges: Array<{ from: number; to: number }>,
  checkFrom: number,
  checkTo: number,
): boolean {
  for (const range of fencedRanges) {
    if (checkFrom < range.to && checkTo > range.from) {
      return true;
    }
  }
  return false;
}

/**
 * 🔧 P1-20 修复：计算 region 的不重叠区段
 * 将可能重叠的 region 范围拆分为不重叠的子段，每个子段记录包含的 UUID 列表。
 */
export function computeRegionSegments(
  ranges: Array<{ uuid: string; from: number; to: number; entry: { start: RegionAnchorMatch; end: RegionAnchorMatch } }>,
): Array<{ from: number; to: number; uuids: string[] }> {
  if (ranges.length === 0) return [];
  if (ranges.length === 1) {
    return [{ from: ranges[0].from, to: ranges[0].to, uuids: [ranges[0].uuid] }];
  }

  const points = new Set<number>();
  for (const r of ranges) {
    points.add(r.from);
    points.add(r.to);
  }
  const sorted = [...points].sort((a, b) => a - b);

  const segments: Array<{ from: number; to: number; uuids: string[] }> = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const segFrom = sorted[i];
    const segTo = sorted[i + 1];
    if (segFrom >= segTo) continue;

    const uuids: string[] = [];
    for (const r of ranges) {
      if (r.from <= segFrom && r.to >= segTo) {
        uuids.push(r.uuid);
      }
    }
    if (uuids.length > 0) {
      segments.push({ from: segFrom, to: segTo, uuids });
    }
  }

  // 合并相邻且 uuids 相同的段
  const merged: Array<{ from: number; to: number; uuids: string[] }> = [];
  for (const seg of segments) {
    const key = seg.uuids.join(',');
    if (merged.length > 0) {
      const last = merged[merged.length - 1];
      if (last.to === seg.from && last.uuids.join(',') === key) {
        last.to = seg.to;
        continue;
      }
    }
    merged.push({ ...seg });
  }

  return merged;
}

/**
 * 🔧 P0-3 优化：限制 findRegionBlockLines 遍历范围
 * 先从文档开头扫描围栏状态（不收集结果），再仅在 region 范围内收集
 */
export function findRegionBlockLines(
  cmDoc: import('@codemirror/state').Text,
  startOffset: number,
  endOffset: number,
): Array<{ from: number }> {
  const result: Array<{ from: number }> = [];
  const startLine = cmDoc.lineAt(startOffset).number;
  const endLine = cmDoc.lineAt(endOffset).number;

  let inCodeBlock = false;
  let inMathBlock = false;

  // 阶段1：从文档开头到 startLine-1，只追踪围栏状态
  for (let ln = 1; ln < startLine; ln++) {
    const trimmed = cmDoc.line(ln).text.trim();
    if (!inCodeBlock && !inMathBlock) {
      if (trimmed.startsWith('```')) inCodeBlock = true;
      else if (trimmed === '$$') inMathBlock = true;
    } else {
      if (inCodeBlock && trimmed.startsWith('```')) inCodeBlock = false;
      else if (inMathBlock && trimmed === '$$') inMathBlock = false;
    }
  }

  // 阶段2：仅在 region 范围内扫描并收集结果
  for (let ln = startLine; ln <= endLine; ln++) {
    const line = cmDoc.line(ln);
    const trimmed = line.text.trim();

    if (!inCodeBlock && !inMathBlock) {
      if (trimmed.startsWith('```')) {
        inCodeBlock = true;
      } else if (trimmed === '$$') {
        inMathBlock = true;
      }
    } else {
      if (inCodeBlock && trimmed.startsWith('```')) {
        inCodeBlock = false;
      } else if (inMathBlock && trimmed === '$$') {
        inMathBlock = false;
      }
    }

    if (inCodeBlock || inMathBlock) {
      result.push({ from: line.from });
    }
  }

  return result;
}
