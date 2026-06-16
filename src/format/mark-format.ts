/**
 * MarkFormat — <mark> HTML 标签格式实现
 *
 * 实现 AnnotationFormat 接口，封装 <mark> 标签的 CRUD 操作。
 * 委托 annotation-parser.ts 中的现有函数，不重写逻辑。
 */

import type { AnnotationFormat, ParsedAnnotation, FormatUpdates } from './format-interface';
import type { Annotation } from '../types/annotation';
import {
  parseAnnotationsFromMarkdown,
  buildMarkTag,
  updateMarkTag,
  removeMarkTag,
} from '../core/annotation-parser';

export class MarkFormat implements AnnotationFormat {
  readonly id = 'mark' as const;

  parse(content: string, filePath: string): ParsedAnnotation[] {
    return parseAnnotationsFromMarkdown(content, filePath);
  }

  build(annotation: Annotation): string {
    return buildMarkTag(annotation);
  }

  update(content: string, uuid: string, changes: FormatUpdates): string | null {
    return updateMarkTag(content, uuid, changes as any);
  }

  remove(content: string, uuid: string): string | null {
    const result = removeMarkTag(content, uuid);
    return result ? result.content : null;
  }

  strip(content: string): string {
    // <mark> HTML 标签 → 保留内部文本
    return content.replace(/<mark[^>]*>([\s\S]*?)<\/mark>/g, '$1');
  }
}
