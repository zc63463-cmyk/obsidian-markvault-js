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
      results.push({
        ...anchor as any,
        filePath,
        tags: [],
        startOffset: anchor.anchorOffset,
        endOffset: anchor.anchorOffset,
        contextBefore: '',
        contextAfter: '',
        createdAt: 0,
        updatedAt: 0,
        _source: 'markdown' as const,
      });
    }

    // 双锚点
    // Note: parseBlockDoubleAnchors + pairing logic is in parseAllAnnotationsFromMarkdown
    // For now, delegate to the full pipeline via the existing parser.
    // The double-anchor pairing logic will be extracted in a future refactoring step.
    return results;
  }

  build(annotation: Annotation): string {
    return buildBlockAnchor(annotation as any);
  }

  update(content: string, uuid: string, changes: FormatUpdates): string | null {
    return updateBlockAnchor(content, uuid, changes as any);
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
