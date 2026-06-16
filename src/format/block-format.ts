/**
 * BlockFormat — block/span 锚点格式实现 (%%markvault%%, %%markvault-span%%, %%markvault-block%%)
 *
 * 封装 block/span 单锚点和 block 双锚点的解析、构建、更新、删除和剥离。
 *
 * 🔧 G-1 修复：补齐双锚点 (%%markvault-block:...:start/end:...%%) 解析，
 * 修复 FormatRegistry.parseAll() 路径下双锚点标注丢失的 P1 Bug。
 * 同时修正单锚点解析中的 targetLine 定位逻辑（与回退路径对齐）。
 */

import type { AnnotationFormat, ParsedAnnotation, FormatUpdates } from './format-interface';
import type { Annotation } from '../types/annotation';
import {
  parseBlockAnchors,
  buildBlockAnchor,
  updateBlockAnchor,
  removeBlockAnchor,
  parseBlockDoubleAnchors,
  buildBlockAnchorStart,
  buildBlockAnchorEnd,
  findBlockTargetLine,
  findBlockContentEndLine,
  findSpanEndLine,
  computeSpanRanges,
} from '../core/annotation-parser';
import {
  computeBlockSignature,
  computeSpanSignature,
  detectBlockTypeAtLine,
} from '../core/block-fingerprint';

export class BlockFormat implements AnnotationFormat {
  readonly id = 'block' as const;

  parse(content: string, filePath: string): ParsedAnnotation[] {
    const results: ParsedAnnotation[] = [];
    const lines = content.split('\n');

    // ── 1. 单锚点 (%%markvault:...%% / %%markvault-span:...%%) ──
    const singleAnchors = parseBlockAnchors(content);
    for (const anchor of singleAnchors) {
      // 🔧 G-1 修正：使用 findBlockTargetLine 跳过锚点行/围栏，找到真实目标行
      // （之前直接取 lines[anchor.anchorLine] 导致取到的是锚点自身文本）
      const actualTargetLine = findBlockTargetLine(content, anchor.anchorLine);
      const isSpan = anchor.anchorKind === 'span';

      let text = lines[actualTargetLine]?.trim() || '';
      let spanRanges: Annotation['spanRanges'];

      // 计算 block/span 目标内容指纹
      const targetHash = isSpan
        ? computeSpanSignature(text)
        : computeBlockSignature(lines, actualTargetLine, isSpan ? undefined : 'paragraph');

      if (isSpan && actualTargetLine < lines.length) {
        // span 标注：收集 actualTargetLine 到下一个空行或下一个锚点行之间的所有内容
        const endLine = findSpanEndLine(lines, actualTargetLine);
        const fullSpanText = lines.slice(actualTargetLine, endLine + 1).join('\n');
        text = fullSpanText.replace(/^%%markvault(-span)?:[^%]+%%\n?/g, '').trim() || fullSpanText;
        spanRanges = computeSpanRanges(content, actualTargetLine, fullSpanText);
      }

      results.push({
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
        alias: anchor.alias,
        _source: 'markdown' as const,
      });
    }

    // ── 2. 双锚点 (%%markvault-block:...:start:...%% / %%markvault-block:...:end:...%%) ──
    // 🔧 G-1 补齐：之前 parse() 直接 return results 跳过了双锚点解析，
    // 导致 FormatRegistry.parseAll() 路径下双锚点 block 标注完全丢失。
    const doubleAnchors = parseBlockDoubleAnchors(content);
    const doubleByUuid = new Map<string, { start?: typeof doubleAnchors[0]; end?: typeof doubleAnchors[0] }>();
    for (const anchor of doubleAnchors) {
      const entry = doubleByUuid.get(anchor.uuid) || {};
      if (anchor.position === 'start') {
        if (!entry.start) entry.start = anchor;
      } else {
        if (!entry.end) entry.end = anchor;
      }
      doubleByUuid.set(anchor.uuid, entry);
    }

    for (const [uuid, entry] of doubleByUuid.entries()) {
      if (!entry.start || !entry.end) continue;

      const targetLine = findBlockTargetLine(content, entry.start.anchorLine);
      const endLine = findBlockContentEndLine(content, entry.end.anchorLine);
      const blockType = detectBlockTypeAtLine(lines, targetLine);
      const blockContent = lines.slice(targetLine, endLine + 1).join('\n');
      const targetHash = computeBlockSignature(lines, targetLine, blockType) || computeSpanSignature(blockContent);

      results.push({
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
        _source: 'markdown' as const,
      });
    }

    return results;
  }

  build(annotation: Pick<Annotation, 'uuid' | 'type' | 'color' | 'note' | 'alias'>): string {
    return buildBlockAnchor(annotation as Parameters<typeof buildBlockAnchor>[0]);
  }

  update(content: string, uuid: string, changes: FormatUpdates): string | null {
    return updateBlockAnchor(content, uuid, {
      type: changes.type,
      color: changes.color,
      note: changes.note,
      alias: changes.alias,
    });
  }

  remove(content: string, uuid: string): string | null {
    return removeBlockAnchor(content, uuid) || null;
  }

  strip(content: string): string {
    // Block/Span 单锚点 + 双锚点
    return content
      .replace(/%%markvault(-span)?:[^:%]+:[^:%]+:[^:%]+(?::[^:%]*)?(?::[^%]*)?%%\n?/g, '')
      .replace(/%%markvault-block:[^:%]+:[^:%]+:[^:%]+:(?:start|end):[^%]*%%\n?/g, '');
  }
}
