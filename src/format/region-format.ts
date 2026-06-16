/**
 * RegionFormat — %%markvault-region%% 区域双锚点格式实现
 */

import type { AnnotationFormat, ParsedAnnotation, FormatUpdates } from './format-interface';
import type { Annotation } from '../types/annotation';
import {
  parseRegionAnnotations,
  buildRegionAnchor,
  updateRegionAnnotation,
  removeRegionAnnotation,
  stripRegionAnnotations,
} from '../core/region-annotation';

export class RegionFormat implements AnnotationFormat {
  readonly id = 'region' as const;

  parse(content: string, filePath: string): ParsedAnnotation[] {
    return parseRegionAnnotations(content, filePath) as ParsedAnnotation[];
  }

  build(annotation: Annotation): string {
    // Region annotations are built as start/end pair anchors
    return buildRegionAnchor(annotation as any, 'start');
  }

  update(content: string, uuid: string, changes: FormatUpdates): string | null {
    return updateRegionAnnotation(content, uuid, changes as any);
  }

  remove(content: string, uuid: string): string | null {
    return removeRegionAnnotation(content, uuid);
  }

  strip(content: string): string {
    return stripRegionAnnotations(content);
  }
}
