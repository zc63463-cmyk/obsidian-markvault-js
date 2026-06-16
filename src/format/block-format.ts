/**
 * BlockFormat — block/span 锚点格式实现 (%%markvault%%, %%markvault-span%%, %%markvault-block%%)
 *
 * 封装 block/span 锚点的解析、构建、更新、删除和剥离。
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
} from '../core/annotation-parser';

export class BlockFormat implements AnnotationFormat {
  readonly id = 'block' as const;

  parse(content: string, filePath: string): ParsedAnnotation[] {
    const results: ParsedAnnotation[] = [];

    // 单锚点
    const singleAnchors = parseBlockAnchors(content);
    for (const anchor of singleAnchors) {
      const lines = content.split('\n');
      const blockContent = lines[anchor.anchorLine]?.trim() || '';
      results.push({
        uuid: anchor.uuid,
        filePath,
        type: anchor.type,
        color: anchor.color,
        text: blockContent,
        note: anchor.note,
        tags: [],
        startOffset: anchor.anchorOffset,
        endOffset: anchor.anchorOffset,
        startLine: anchor.anchorLine,
        contextBefore: '',
        contextAfter: '',
        createdAt: 0,
        updatedAt: 0,
        kind: anchor.anchorKind === 'span' ? 'span' as const : 'block' as const,
        anchorLine: anchor.anchorLine,
        alias: anchor.alias,
        _source: 'markdown' as const,
      });
    }

    // 双锚点：委托给 parseAllAnnotationsFromMarkdown 的完整逻辑
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
