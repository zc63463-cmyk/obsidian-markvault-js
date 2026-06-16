/**
 * NativeFormat — %%mv:i%% 隐身锚点 + HTML 包裹格式实现
 */

import type { AnnotationFormat, ParsedAnnotation, FormatUpdates } from './format-interface';
import type { Annotation } from '../types/annotation';
import {
  parseNativeAnnotations,
  buildNativeAnnotation,
  updateNativeAnnotation,
  removeNativeAnnotation,
  stripNativeAnnotations,
} from '../core/native-annotation';

export class NativeFormat implements AnnotationFormat {
  readonly id = 'native' as const;

  parse(content: string, filePath: string): ParsedAnnotation[] {
    return parseNativeAnnotations(content, filePath) as ParsedAnnotation[];
  }

  build(annotation: Annotation): string {
    return buildNativeAnnotation(annotation as any);
  }

  update(content: string, uuid: string, changes: FormatUpdates): string | null {
    return updateNativeAnnotation(content, uuid, changes as any);
  }

  remove(content: string, uuid: string): string | null {
    return removeNativeAnnotation(content, uuid);
  }

  strip(content: string): string {
    return stripNativeAnnotations(content);
  }
}
