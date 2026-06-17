/**
 * 块级/SPAN 锚点标注解析器 — Track B
 *
 * 处理三种锚点格式：
 * 1. Block 单锚点: %%markvault:uuid:type:color:alias:note%%
 * 2. Span 单锚点:  %%markvault-span:uuid:type:color:alias:note%%
 * 3. Block 双锚点: %%markvault-block:uuid:type:color:start:end:note:alias%%
 *
 * 提供 parse/build/remove/update 完整生命周期。
 * 锚点字段转义使用数字后缀 (\0=\, \1=%, \2=:) 避免原文冲突。
 *
 * @module block-annotation-parser
 */

import type { Annotation, SpanRange } from '../types/annotation';
import type { AnnotationType } from '../types/annotation';
import { computeBlockSignature, computeSpanSignature, detectBlockTypeAtLine } from './block-fingerprint';
import { scanMarkdownContexts } from './md-context';
import { escapeRegex } from './inline-annotation-parser';

// ─── 锚点字段转义 ──────────────────────────────────────────

/**
 * 锚点字段转义 — 在 block/span 单锚点和 span 锚点中使用
 *
 * 转义规则：
 * - `\` → `\0`（先转义转义符，防止后续 \1/\2 与原文混淆）
 * - `\n` → ` `（锚点不跨行，换行符替换为空格）
 * - `%` → `\1`（百分号是锚点 %% 终止符）
 * - `:` → `\2`（冒号是段分隔符）
 *
 * 🔧 P0-1 修复：v5.x 版本中此函数不转义 %。
 * 🔧 P2-4 修复：新增 \n 安全替换。
 * 🔧 解码安全修复：使用数字后缀 (\0/\1/\2) 替代助记后缀 (\p/\c)，
 *   避免原文中的字面量 \p/\c 被误解码。
 */
export function escapeAnchorField(s: string): string {
  return s.replace(/\\/g, '\\0').replace(/\n/g, ' ').replace(/%/g, '\\1').replace(/:/g, '\\2');
}

/** 锚点字段反转义（解码顺序必须与编码相反） */
export function decodeAnchorField(s: string): string {
  return s.replace(/\\2/g, ':').replace(/\\1/g, '%').replace(/\\0/g, '\\');
}

// ─── Block/Span 单锚点构建 ─────────────────────────────────

/**
 * 生成块级标注锚点字符串
 * v5.3: 新增 alias 段，格式 %%markvault:uuid:type:color:alias:note%%
 * alias 为空时写入 _ 占位符，保持冒号对齐和向后兼容
 */
export function buildBlockAnchor(annotation: {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
  alias?: string;
}): string {
  const aliasField = annotation.alias ? escapeAnchorField(annotation.alias) : '_';
  return `%%markvault:${annotation.uuid}:${annotation.type}:${annotation.color}:${aliasField}:${escapeAnchorField(annotation.note || '')}%%`;
}

/**
 * 生成 span 标注锚点字符串（方案C）
 * 使用 markvault-span: 前缀区分于 block 标注的 markvault: 前缀
 * v5.3: 新增 alias 段，格式 %%markvault-span:uuid:type:color:alias:note%%
 */
export function buildSpanAnchor(annotation: {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
  alias?: string;
}): string {
  const aliasField = annotation.alias ? escapeAnchorField(annotation.alias) : '_';
  return `%%markvault-span:${annotation.uuid}:${annotation.type}:${annotation.color}:${aliasField}:${escapeAnchorField(annotation.note || '')}%%`;
}

// ─── Block 双锚点 ──────────────────────────────────────────

/** Block 双锚点正则：%%markvault-block:<uuid>:<type>:<color>:<start|end>:<note>[:<alias>]%% */
export const BLOCK_DOUBLE_ANCHOR_REGEX = /%%markvault-block:([^:%]+):([^:%]+):([^:%]+):(start|end):([^%]*?)(?::([^%]*))?%%/g;

/** 双锚点 note 字段转义（数字后缀 \0=\ \1=% \2=:）
 *
 * 🔧 P2-4 修复：新增 \n → 空格替换。
 * 🔧 解码安全修复：使用数字后缀避免原文 \p/\c 误解码。
 */
export function escapeBlockAnchorField(s: string): string {
  return s.replace(/\\/g, '\\0').replace(/\n/g, ' ').replace(/%/g, '\\1').replace(/:/g, '\\2');
}

/** 双锚点 note 字段反转义 */
export function decodeBlockAnchorField(s: string): string {
  return s.replace(/\\2/g, ':').replace(/\\1/g, '%').replace(/\\0/g, '\\');
}

/** 生成 Block 双锚点的 start 锚点 */
export function buildBlockAnchorStart(annotation: {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
  alias?: string;
}): string {
  const escapedAlias = annotation.alias ? `:${escapeBlockAnchorField(annotation.alias)}` : '';
  return `%%markvault-block:${annotation.uuid}:${annotation.type}:${annotation.color}:start:${escapeBlockAnchorField(annotation.note || '')}${escapedAlias}%%`;
}

/** 生成 Block 双锚点的 end 锚点 */
export function buildBlockAnchorEnd(annotation: {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
  alias?: string;
}): string {
  const escapedAlias = annotation.alias ? `:${escapeBlockAnchorField(annotation.alias)}` : '';
  return `%%markvault-block:${annotation.uuid}:${annotation.type}:${annotation.color}:end:${escapeBlockAnchorField(annotation.note || '')}${escapedAlias}%%`;
}

// ─── Block 双锚点解析 ──────────────────────────────────────

/** Block 双锚点解析结果 */
export interface ParsedBlockDoubleAnchor {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
  alias?: string;
  /** start / end */
  position: 'start' | 'end';
  /** 锚点在全文中的字符偏移 */
  anchorOffset: number;
  /** 锚点字符串长度 */
  anchorLength: number;
  /** 锚点所在行号（0-based） */
  anchorLine: number;
}

/**
 * 解析 Block 双锚点标注
 * 格式（新）：%%markvault-block:<uuid>:<type>:<color>:start:<note>:<alias>%% ... %%markvault-block:<uuid>:...:end:<note>:<alias>%%
 * 格式（旧）：%%markvault-block:<uuid>:<type>:<color>:start:<note>%% ... %%markvault-block:<uuid>:...:end:<note>%%
 */
export function parseBlockDoubleAnchors(content: string): ParsedBlockDoubleAnchor[] {
  const results: ParsedBlockDoubleAnchor[] = [];
  let match: RegExpExecArray | null;

  BLOCK_DOUBLE_ANCHOR_REGEX.lastIndex = 0;
  while ((match = BLOCK_DOUBLE_ANCHOR_REGEX.exec(content)) !== null) {
    const anchorOffset = match.index;
    const anchorLength = match[0].length;
    const lineCount = content.substring(0, anchorOffset).split('\n').length;
    const alias = match[6] ? decodeBlockAnchorField(match[6]) : undefined;
    results.push({
      uuid: match[1],
      type: match[2] as AnnotationType,
      color: match[3],
      note: decodeBlockAnchorField(match[5]),
      ...(alias ? { alias } : {}),
      position: match[4] as 'start' | 'end',
      anchorOffset,
      anchorLength,
      anchorLine: lineCount - 1,
    });
  }

  return results;
}

// ─── Block 双锚点范围定位 ──────────────────────────────────

/** Block 双锚点范围定位结果 */
export interface BlockDoubleAnchorRange {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
  alias?: string;
  startAnchorOffset: number;
  startAnchorEnd: number;
  endAnchorOffset: number;
  endAnchorEnd: number;
  contentStart: number;
  contentEnd: number;
  text: string;
  startLine: number;
  endLine: number;
  targetLine: number;
  anchorLine: number;
}

/**
 * 在文档中查找指定 uuid 的 Block 双锚点范围
 */
export function findBlockDoubleAnchorRange(content: string, uuid: string): BlockDoubleAnchorRange | null {
  const matches = parseBlockDoubleAnchors(content);
  const startMatch = matches.find(m => m.uuid === uuid && m.position === 'start');
  if (!startMatch) return null;

  const endMatch = matches.find(m => m.uuid === uuid && m.position === 'end' && m.anchorOffset > startMatch.anchorOffset);
  if (!endMatch) return null;

  const lines = content.split('\n');
  const targetLine = findBlockTargetLine(content, startMatch.anchorLine);
  const endLine = findBlockContentEndLine(content, endMatch.anchorLine);

  return {
    uuid,
    type: startMatch.type,
    color: startMatch.color,
    note: startMatch.note,
    ...(startMatch.alias ? { alias: startMatch.alias } : {}),
    startAnchorOffset: startMatch.anchorOffset,
    startAnchorEnd: startMatch.anchorOffset + startMatch.anchorLength,
    endAnchorOffset: endMatch.anchorOffset,
    endAnchorEnd: endMatch.anchorOffset + endMatch.anchorLength,
    contentStart: startMatch.anchorOffset + startMatch.anchorLength,
    contentEnd: endMatch.anchorOffset,
    text: lines.slice(targetLine, endLine + 1).join('\n'),
    startLine: targetLine,
    endLine,
    targetLine,
    anchorLine: startMatch.anchorLine,
  };
}

// ─── 行号定位工具 ──────────────────────────────────────────

/**
 * 给定 end 锚点所在行号，向前扫描找到目标块内容的真实结束行号。
 * 跳过：空行、其它锚点行、代码/公式围栏分隔符。
 */
export function findBlockContentEndLine(content: string, endLine: number): number {
  const lines = content.split('\n');
  let actualEndLine = endLine - 1;

  for (let i = endLine - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (
      trimmed.startsWith('%%markvault') ||
      trimmed === '$$' ||
      trimmed.startsWith('```') ||
      trimmed === ''
    ) {
      actualEndLine = i - 1;
      continue;
    }
    actualEndLine = i;
    break;
  }

  return Math.max(0, actualEndLine);
}

/**
 * 给定锚点所在行号，向前扫描找到目标块的实际起始行号。
 * 跳过：空行、其它锚点行、代码/公式围栏分隔符。
 * 用于创建/渲染时动态定位目标块，避免依赖可能过期的 targetLine。
 */
export function findBlockTargetLine(content: string, anchorLine: number): number {
  const lines = content.split('\n');
  const targetLine = anchorLine + 1;
  let actualTargetLine = targetLine;

  for (let i = targetLine; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('%%markvault') || trimmed === '$$' || trimmed.startsWith('```')) {
      actualTargetLine = i + 1;
      continue;
    }
    if (trimmed === '') {
      actualTargetLine = i + 1;
      continue;
    }
    actualTargetLine = i;
    break;
  }

  return actualTargetLine;
}

// ─── Block/Span 单锚点解析 ─────────────────────────────────

/** 块级锚点解析结果 */
export interface ParsedBlockAnchor {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
  alias?: string;    // v5.3: 图谱别名（从锚点解析）
  /** 锚点在全文中的字符偏移 */
  anchorOffset: number;
  /** 锚点所在行号（0-based） */
  anchorLine: number;
  /** 锚点类型标记：block 或 span */
  anchorKind: 'block' | 'span';
}

/**
 * 从 Markdown 内容中解析所有块级标注锚点
 * 支持 %%markvault:...%% (block) 和 %%markvault-span:...%% (span) 两种格式
 *
 * v5.3: 新格式含 alias 段 %%markvault:uuid:type:color:alias:note%%
 *       旧格式无 alias 段 %%markvault:uuid:type:color:note%% 仍可解析（alias 默认为空）
 */
export function parseBlockAnchors(content: string): ParsedBlockAnchor[] {
  const results: ParsedBlockAnchor[] = [];

  // 1. 解析 block 格式
  // v5.3 新格式: %%markvault:uuid:type:color:alias:note%% (6段)
  // 旧格式: %%markvault:uuid:type:color:note%% (4-5段, 无 alias)
  // 使用统一正则匹配，根据段数区分
  const blockRegex = /%%markvault:([^:%]+):([^:%]+):([^:%]+)(?::([^:%]*))?(?::([^%]*))?%%/g;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(content)) !== null) {
    const anchorOffset = match.index;
    const lineCount = content.substring(0, anchorOffset).split('\n').length;
    // match[4] 和 match[5] 的存在取决于段数
    // 旧格式 (4段): match[1]=uuid, match[2]=type, match[3]=color, match[4]=note, match[5]=undefined
    // 新格式 (6段): match[1]=uuid, match[2]=type, match[3]=color, match[4]=alias, match[5]=note
    const hasAliasSegment = match[5] !== undefined;
    let alias: string | undefined;
    let note: string;
    if (hasAliasSegment) {
      // 新格式: match[4]=alias, match[5]=note
      const rawAlias = match[4];
      alias = (rawAlias && rawAlias !== '_') ? decodeAnchorField(rawAlias) : undefined;
      note = match[5] ? decodeAnchorField(match[5]) : '';
    } else {
      // 旧格式: match[4]=note, 无 alias
      note = match[4] ? decodeAnchorField(match[4]) : '';
    }
    results.push({
      uuid: match[1],
      type: match[2] as AnnotationType,
      color: match[3],
      note,
      alias,
      anchorOffset,
      anchorLine: lineCount - 1,
      anchorKind: 'block',
    });
  }

  // 2. 解析 span 格式
  // 同样支持新格式（含 alias）和旧格式
  const spanRegex = /%%markvault-span:([^:%]+):([^:%]+):([^:%]+)(?::([^:%]*))?(?::([^%]*))?%%/g;
  while ((match = spanRegex.exec(content)) !== null) {
    const anchorOffset = match.index;
    const lineCount = content.substring(0, anchorOffset).split('\n').length;
    const hasAliasSegment = match[5] !== undefined;
    let alias: string | undefined;
    let note: string;
    if (hasAliasSegment) {
      const rawAlias = match[4];
      alias = (rawAlias && rawAlias !== '_') ? decodeAnchorField(rawAlias) : undefined;
      note = match[5] ? decodeAnchorField(match[5]) : '';
    } else {
      note = match[4] ? decodeAnchorField(match[4]) : '';
    }
    results.push({
      uuid: match[1],
      type: match[2] as AnnotationType,
      color: match[3],
      note,
      alias,
      anchorOffset,
      anchorLine: lineCount - 1,
      anchorKind: 'span',
    });
  }

  return results;
}

// ─── 锚点删除 ─────────────────────────────────────────────

/**
 * 从 Markdown 内容中移除指定 uuid 的块级锚点
 * 优先尝试新的双锚点格式，找不到则回退到旧单锚点格式。
 */
export function removeBlockAnchor(content: string, uuid: string): string {
  const doubleRange = findBlockDoubleAnchorRange(content, uuid);
  if (doubleRange) {
    return (
      content.substring(0, doubleRange.startAnchorOffset) +
      content.substring(doubleRange.startAnchorEnd, doubleRange.endAnchorOffset) +
      content.substring(doubleRange.endAnchorEnd)
    );
  }

  // 🔧 P2-7 修复：使用非全局正则 + 手动 match，仅删除第一个匹配项。
  // 防御数据损坏场景下 uuid 多次出现导致误删所有匹配。
  const regex = new RegExp(`%%markvault:${escapeRegex(uuid)}:[\\s\\S]*?%%\\n?`);
  const match = content.match(regex);
  if (!match) return content;
  return content.replace(regex, '');
}

/**
 * 从 Markdown 内容中移除指定 uuid 的 span 锚点
 */
export function removeSpanAnchor(content: string, uuid: string): string {
  // 🔧 P1 修复：使用非贪婪匹配，避免 note 中包含 % 时截断
  const regex = new RegExp(`%%markvault-span:${escapeRegex(uuid)}:[\\s\\S]*?%%\\n?`, 'g');
  return content.replace(regex, '');
}

/**
 * 移除任意类型的锚点（block 或 span），根据 kind 自动选择
 */
export function removeAnyAnchor(content: string, uuid: string, kind?: string): string {
  if (kind === 'span') {
    return removeSpanAnchor(content, uuid);
  }
  // 先尝试 block，再尝试 span（兼容不确定 kind 的情况）
  let result = removeBlockAnchor(content, uuid);
  if (result === content) {
    result = removeSpanAnchor(content, uuid);
  }
  return result;
}

// ─── 锚点更新 ─────────────────────────────────────────────

/**
 * 更新 Markdown 内容中指定 uuid 的块级锚点属性
 * 优先尝试新的双锚点格式，找不到则回退到旧单锚点格式。
 * v5.3: 支持 alias 字段的更新
 */
export function updateBlockAnchor(
  content: string,
  uuid: string,
  updates: Partial<{
    type: AnnotationType;
    color: string;
    note: string;
    alias?: string;
  }>,
): string {
  const range = findBlockDoubleAnchorRange(content, uuid);
  if (range) {
    const type = updates.type ?? range.type;
    const color = updates.color ?? range.color;
    const note = updates.note !== undefined ? updates.note : range.note;
    const alias = updates.alias !== undefined ? updates.alias : range.alias;
    const startAnchor = buildBlockAnchorStart({ uuid, type, color, note, alias });
    const endAnchor = buildBlockAnchorEnd({ uuid, type, color, note, alias });
    return (
      content.substring(0, range.startAnchorOffset) +
      startAnchor +
      content.substring(range.startAnchorEnd, range.endAnchorOffset) +
      endAnchor +
      content.substring(range.endAnchorEnd)
    );
  }

  // v5.3: 匹配新格式（含 alias 段）或旧格式（无 alias 段），统一更新为新格式
  // 新格式: %%markvault:uuid:type:color:alias:note%%
  // 旧格式: %%markvault:uuid:type:color:note%%
  const regex = new RegExp(`%%markvault:${escapeRegex(uuid)}:([^:%]*):([^:%]*)(?::([^:%]*))?(?::([^%]*))?%%`);

  return content.replace(regex, (_full, oldType: string, oldColor: string, g3: string | undefined, g4: string | undefined) => {
    const type = updates.type ?? oldType;
    const color = updates.color ?? oldColor;

    // 判断匹配到的是新格式还是旧格式
    const isNewFormat = g4 !== undefined;
    let oldAlias: string | undefined;
    let oldNote: string;
    if (isNewFormat) {
      // 新格式: g3=alias, g4=note
      oldAlias = (g3 && g3 !== '_') ? decodeAnchorField(g3) : undefined;
      oldNote = g4 ? decodeAnchorField(g4) : '';
    } else {
      // 旧格式: g3=note, 无 alias
      oldNote = g3 ? decodeAnchorField(g3) : '';
    }

    const note = updates.note !== undefined ? updates.note : oldNote;
    const alias = updates.alias !== undefined ? updates.alias : oldAlias;
    const aliasField = alias ? escapeAnchorField(alias) : '_';

    // 始终输出新格式（含 alias 段）
    return `%%markvault:${uuid}:${type}:${color}:${aliasField}:${escapeAnchorField(note)}%%`;
  });
}

/**
 * 更新 Markdown 内容中指定 uuid 的 span 锚点属性
 * v5.3: 支持 alias 字段的更新
 */
export function updateSpanAnchor(
  content: string,
  uuid: string,
  updates: Partial<{
    type: AnnotationType;
    color: string;
    note: string;
    alias?: string;
  }>,
): string {
  // v5.3: 匹配新格式或旧格式，统一更新为新格式
  const regex = new RegExp(`%%markvault-span:${escapeRegex(uuid)}:([^:%]*):([^:%]*)(?::([^:%]*))?(?::([^%]*))?%%`);

  return content.replace(regex, (_full, oldType: string, oldColor: string, g3: string | undefined, g4: string | undefined) => {
    const type = updates.type ?? oldType;
    const color = updates.color ?? oldColor;

    const isNewFormat = g4 !== undefined;
    let oldAlias: string | undefined;
    let oldNote: string;
    if (isNewFormat) {
      oldAlias = (g3 && g3 !== '_') ? decodeAnchorField(g3) : undefined;
      oldNote = g4 ? decodeAnchorField(g4) : '';
    } else {
      oldNote = g3 ? decodeAnchorField(g3) : '';
    }

    const note = updates.note !== undefined ? updates.note : oldNote;
    const alias = updates.alias !== undefined ? updates.alias : oldAlias;
    const aliasField = alias ? escapeAnchorField(alias) : '_';

    return `%%markvault-span:${uuid}:${type}:${color}:${aliasField}:${escapeAnchorField(note)}%%`;
  });
}

/**
 * 更新任意类型的锚点（block 或 span），根据 kind 自动选择
 * v5.3: 支持 alias 字段更新
 */
export function updateAnyAnchor(
  content: string,
  uuid: string,
  updates: Partial<{
    type: AnnotationType;
    color: string;
    note: string;
    alias?: string;
  }>,
  kind?: string,
): string {
  if (kind === 'span') {
    return updateSpanAnchor(content, uuid, updates);
  }
  // 先尝试 block，如果没匹配到再尝试 span
  const result = updateBlockAnchor(content, uuid, updates);
  if (result === content) {
    return updateSpanAnchor(content, uuid, updates);
  }
  return result;
}

// ─── Span 范围计算 ─────────────────────────────────────────

/**
 * 查找 span 标注覆盖的结束行
 * 从 targetLine 开始，到空行或下一个锚点行为止
 */
export function findSpanEndLine(lines: string[], startLine: number): number {
  let endLine = startLine;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i].trim();
    // 🔧 修复：如果是锚点行且 i === startLine，也跳过（因为 span 锚点可能落在 targetLine 上）
    if (/^%%markvault(-span)?:/.test(line)) {
      if (i === startLine) {
        // targetLine 本身就是锚点行，跳到下一个有效行
        continue;
      }
      if (i > startLine) {
        endLine = i - 1;
      }
      break;
    }
    // 空行 → 结束
    if (line === '') {
      if (i > startLine) {
        endLine = i - 1;
      }
      break;
    }
    endLine = i;
  }
  return endLine;
}

/**
 * 计算 span 标注的文本片段偏移范围
 * 扫描目标内容中的特殊区域，返回纯文本片段的文档偏移
 */
export function computeSpanRanges(content: string, targetLine: number, targetText: string): SpanRange[] {
  // 计算目标行在文档中的偏移
  const lines = content.split('\n');
  let lineOffset = 0;
  for (let i = 0; i < targetLine; i++) {
    lineOffset += lines[i].length + 1; // +1 for \n
  }

  // 扫描目标文本的特殊内容
  const scanResult = scanMarkdownContexts(targetText);
  const ranges: SpanRange[] = [];

  for (const seg of scanResult.segments) {
    if (seg.type === 'text' && seg.content.trim().length > 0) {
      ranges.push({
        from: lineOffset + seg.startOffset,
        to: lineOffset + seg.endOffset,
      });
    }
  }

  return ranges;
}
