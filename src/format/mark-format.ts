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
import { encodeFields } from '../utils/fields';

export class MarkFormat implements AnnotationFormat {
  readonly id = 'mark' as const;

  parse(content: string, filePath: string): ParsedAnnotation[] {
    return parseAnnotationsFromMarkdown(content, filePath);
  }

  build(annotation: Annotation): string {
    return buildMarkTag(annotation);
  }

  update(content: string, uuid: string, changes: FormatUpdates): string | null {
    // 🔧 B-5 修复：fields 可能是 Record<string, string>，需用 encodeFields 转换
    const fieldsStr = typeof changes.fields === 'string'
      ? changes.fields
      : changes.fields ? encodeFields(changes.fields) : undefined;
    return updateMarkTag(content, uuid, {
      note: changes.note,
      tags: changes.tags,
      color: changes.color,
      type: changes.type,
      alias: changes.alias,
      fields: fieldsStr,
    });
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
