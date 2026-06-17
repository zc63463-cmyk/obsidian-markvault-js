/**
 * 标注解析器 — 统一入口 + FormatRegistry 桥接
 *
 * 职责：
 * 1. 转发 Track A (inline <mark>) 和 Track B (block/span 锚点) 的符号
 * 2. 提供 parseAllAnnotationsFromMarkdown 统一解析入口
 * 3. FormatRegistry 注入/获取
 *
 * 外部消费者无需修改 import 路径 — 所有符号通过此文件 re-export。
 *
 * @module annotation-parser
 */

import type { Annotation, SpanRange } from '../types/annotation';
import { computeBlockSignature, computeSpanSignature, detectBlockTypeAtLine } from './block-fingerprint';
import { parseNativeAnnotations } from './native-annotation';
import { parseRegionAnnotations } from './region-annotation';
// 🔧 Phase 5B: Track A (inline <mark>) extracted to inline-annotation-parser.ts
import { parseAnnotationsFromMarkdown } from './inline-annotation-parser';
// 🔧 Phase 5B: Track B (block/span/block双锚点) extracted to block-annotation-parser.ts
import {
  parseBlockAnchors,
  parseBlockDoubleAnchors,
  findBlockTargetLine,
  findBlockContentEndLine,
  findSpanEndLine,
  computeSpanRanges,
  type ParsedBlockDoubleAnchor,
} from './block-annotation-parser';

// ─── Track A re-exports ──────────────────────────────────────
export {
  parseAnnotationsFromMarkdown,
  buildMarkTag,
  removeMarkTag,
  updateMarkTag,
  escapeRegex,
} from './inline-annotation-parser';

// ─── Track B re-exports ──────────────────────────────────────
export {
  parseBlockAnchors,
  buildBlockAnchor,
  buildSpanAnchor,
  BLOCK_DOUBLE_ANCHOR_REGEX,
  escapeBlockAnchorField,
  decodeBlockAnchorField,
  buildBlockAnchorStart,
  buildBlockAnchorEnd,
  parseBlockDoubleAnchors,
  findBlockDoubleAnchorRange,
  findBlockContentEndLine,
  findBlockTargetLine,
  ParsedBlockDoubleAnchor,
  BlockDoubleAnchorRange,
  ParsedBlockAnchor,
  removeBlockAnchor,
  removeSpanAnchor,
  removeAnyAnchor,
  updateBlockAnchor,
  updateSpanAnchor,
  updateAnyAnchor,
  findSpanEndLine,
  computeSpanRanges,
  escapeAnchorField,
  decodeAnchorField,
} from './block-annotation-parser';

// ─── FormatRegistry 注入 ────────────────────────────────────

// 🔧 Phase G-2: 延迟导入 FormatRegistry 避免循环依赖
let _formatRegistry: import('../format/format-registry').FormatRegistry | null = null; /** 注入 FormatRegistry（由 plugin 初始化时调用） */
export function injectFormatRegistry(registry: import('../format/format-registry').FormatRegistry): void {
  _formatRegistry = registry;
}
/** 获取已注入的 FormatRegistry（用于解析器内部） */
export function getFormatRegistry(): import('../format/format-registry').FormatRegistry | null {
  return _formatRegistry;
}

// ─── 统一解析入口 ──────────────────────────────────────────

/**
 * 从 Markdown 内容解析所有标注（包括行内 <mark> 和块级/span 锚点）
 * 统一入口，供 markdown-sync.ts 使用
 */
export function parseAllAnnotationsFromMarkdown(
  content: string,
  filePath: string,
): Array<Annotation & { _source: 'markdown'; _needsUpgrade?: boolean }> {
  // 🔧 Phase G-2: FormatRegistry 注入后使用统一解析入口
  if (_formatRegistry) {
    return _formatRegistry.parseAll(content, filePath);
  }

  // 🔧 P2-6 修复：回退路径 — 每个子解析器独立 try-catch
  // 1. 行内 <mark> 标注
  let inlineAnnotations: Array<Annotation & { _source: 'markdown'; _needsUpgrade?: boolean }> = [];
  try {
    inlineAnnotations = parseAnnotationsFromMarkdown(content, filePath);
  } catch (err) {
    console.error('MarkVault: inline <mark> parse error', err);
  }

  // 2. 块级/span 锚点标注
  const blockAnchors = parseBlockAnchors(content);
  // 🔧 BUG-16 修复：map 抛异常后整个 blockAnnotations 变空数组，
  // 所有有效锚点都丢失。改为逐条 try-catch，跳过出错项。
  let blockAnnotations: Array<Annotation & { _source: 'markdown' }> = [];
  for (const anchor of blockAnchors) {
    try {
    // 🔧 修复：跳过锚点行、公式分隔符、代码围栏，找到有意义的内容行
    const lines = content.split('\n');
    const actualTargetLine = findBlockTargetLine(content, anchor.anchorLine);
    const blockContent = lines[actualTargetLine]?.trim() || '';

    const isSpan = anchor.anchorKind === 'span';

    // 对 span 标注，计算 spanRanges（文本片段的偏移范围）
    let spanRanges: SpanRange[] | undefined;
    let text = blockContent;

    // 计算 block/span 目标内容指纹
    const targetHash = isSpan
      ? computeSpanSignature(text)
      : computeBlockSignature(lines, actualTargetLine, isSpan ? undefined : 'paragraph');

    if (isSpan && actualTargetLine < lines.length) {
      // span 标注：收集 actualTargetLine 到下一个空行或下一个锚点行之间的所有内容
      const endLine = findSpanEndLine(lines, actualTargetLine);
      const fullSpanText = lines.slice(actualTargetLine, endLine + 1).join('\n');
      // 过滤掉锚点行本身（以防 targetLine 回退到锚点行）
      text = fullSpanText.replace(/^%%markvault(-span)?:[^%]+%%\n?/g, '').trim() || fullSpanText;

      // 计算文本片段在文档中的偏移
      spanRanges = computeSpanRanges(content, actualTargetLine, fullSpanText);
    }

    blockAnnotations.push({
      uuid: anchor.uuid,
      filePath,
      type: anchor.type,
      color: anchor.color,
      text,
      note: anchor.note,
      tags: [],
      startOffset: anchor.anchorOffset,
      endOffset: anchor.anchorOffset,
      startLine: actualTargetLine,
      contextBefore: '',
      contextAfter: '',
      createdAt: 0,
      updatedAt: 0,
      kind: isSpan ? 'span' as const : 'block' as const,
      blockType: isSpan ? undefined : 'paragraph',
      targetLine: actualTargetLine,
      anchorLine: anchor.anchorLine,
      spanRanges,
      targetHash,
      alias: anchor.alias,  // v5.3: 从锚点解析的 alias
      _source: 'markdown' as const,
    });
    } catch (err) {
      console.error(`MarkVault: block/span anchor parse error for uuid=${anchor.uuid}`, err);
    }
  }

  // 3. Block 双锚点标注
  try {
  const doubleBlockAnchors = parseBlockDoubleAnchors(content);
  const doubleByUuid = new Map<string, { start?: ParsedBlockDoubleAnchor; end?: ParsedBlockDoubleAnchor }>();
  for (const anchor of doubleBlockAnchors) {
    const entry = doubleByUuid.get(anchor.uuid) || {};
    if (anchor.position === 'start') {
      if (!entry.start) entry.start = anchor;
    } else {
      if (!entry.end) entry.end = anchor;
    }
    doubleByUuid.set(anchor.uuid, entry);
  }

  for (const [uuid, entry] of doubleByUuid.entries()) {
    if (!entry.start || !entry.end) {
      if (entry.start) console.warn(`MarkVault: orphaned block double-anchor start (uuid=${uuid}, no matching end)`);
      if (entry.end) console.warn(`MarkVault: orphaned block double-anchor end (uuid=${uuid}, no matching start)`);
      continue;
    }
    // 🔧 BUG-1 修复：校验 end 在 start 之后
    if (entry.end.anchorOffset < entry.start.anchorOffset) {
      console.warn(`MarkVault: block double-anchor end before start (uuid=${uuid}), skipping`);
      continue;
    }

    const lines = content.split('\n');
    const targetLine = findBlockTargetLine(content, entry.start.anchorLine);
    const endLine = findBlockContentEndLine(content, entry.end.anchorLine);
    const blockType = detectBlockTypeAtLine(lines, targetLine);
    const blockContent = lines.slice(targetLine, endLine + 1).join('\n');
    const targetHash = computeBlockSignature(lines, targetLine, blockType) || computeSpanSignature(blockContent);

    blockAnnotations.push({
      uuid,
      filePath,
      type: entry.start.type,
      color: entry.start.color,
      text: blockContent,
      note: entry.start.note,
      tags: [],
      startOffset: entry.start.anchorOffset,
      endOffset: entry.end.anchorOffset + entry.end.anchorLength,
      startLine: targetLine,
      endLine,
      contextBefore: '',
      contextAfter: '',
      createdAt: 0,
      updatedAt: 0,
      kind: 'block' as const,
      blockType,
      targetLine,
      anchorLine: entry.start.anchorLine,
      targetHash,
      ...(entry.start.alias ? { alias: entry.start.alias } : {}),
      _source: 'markdown' as const,
    });
  }
  } catch (err) {
    console.error('MarkVault: block double-anchor parse error', err);
  }

  // 4. 区域标注（双锚点包围）
  let regionAnnotations: Array<Annotation & { _source: 'markdown' }> = [];
  try {
    regionAnnotations = parseRegionAnnotations(content, filePath);
  } catch (err) {
    console.error('MarkVault: region annotation parse error', err);
  }

  // 5. 自然语法标注（隐身锚点 + 原生包裹）
  let nativeAnnotations: Array<Annotation & { _source: 'markdown' }> = [];
  try {
    nativeAnnotations = parseNativeAnnotations(content, filePath);
  } catch (err) {
    console.error('MarkVault: native annotation parse error', err);
  }

  // 🔧 A-2 修复：native 标注的 <mark> wrapper 同时被 inline parser 和 native parser 双重拾取。
  // native parser 的结果 offset 更准确（从 %%mv:i%% 锚点计算），inline parser 的 offset 从 <mark> 标签计算。
  // 冲突时优先保留 native parser 的结果。
  const allAnnotations = [...inlineAnnotations, ...blockAnnotations, ...regionAnnotations, ...nativeAnnotations];
  const seen = new Map<string, Annotation & { _source: 'markdown'; _needsUpgrade?: boolean }>();
  for (const ann of allAnnotations) {
    const existing = seen.get(ann.uuid);
    if (!existing || (ann.format === 'native' && existing.format !== 'native')) {
      seen.set(ann.uuid, ann);
    }
  }
  return [...seen.values()];
}
