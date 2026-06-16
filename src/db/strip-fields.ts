import type { Annotation } from '../types/annotation';

/**
 * 过滤非标准字段（以 _ 开头的临时标记），
 * 防止解析器的临时标记被写入分片 JSON。
 */
export function stripExtraFields(annotation: Annotation): Annotation {
  const clean: Annotation = {
    uuid: annotation.uuid,
    filePath: annotation.filePath,
    type: annotation.type,
    color: annotation.color,
    text: annotation.text,
    note: annotation.note,
    tags: annotation.tags,
    startOffset: annotation.startOffset,
    endOffset: annotation.endOffset,
    startLine: annotation.startLine,
    contextBefore: annotation.contextBefore,
    contextAfter: annotation.contextAfter,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
  };
  if (annotation.schemaVersion !== undefined) clean.schemaVersion = annotation.schemaVersion;
  if (annotation.kind !== undefined) clean.kind = annotation.kind;
  if (annotation.groupUuid !== undefined) clean.groupUuid = annotation.groupUuid;
  if (annotation.endLine !== undefined) clean.endLine = annotation.endLine;
  if (annotation.blockType !== undefined) clean.blockType = annotation.blockType;
  if (annotation.targetLine !== undefined) clean.targetLine = annotation.targetLine;
  if (annotation.anchorLine !== undefined) clean.anchorLine = annotation.anchorLine;
  if (annotation.spanRanges !== undefined) clean.spanRanges = annotation.spanRanges;
  if (annotation.fields !== undefined) {
    if (Object.keys(annotation.fields).length > 0) {
      clean.fields = annotation.fields;
    }
  }
  if (annotation.format !== undefined) clean.format = annotation.format;
  if (annotation.targetHash !== undefined) clean.targetHash = annotation.targetHash;
  if (annotation.relations !== undefined && annotation.relations.length > 0) {
    clean.relations = annotation.relations;
  }
  if (annotation.flags !== undefined) {
    const f = annotation.flags;
    const hasValue = f.mastery !== undefined || f.reviewPriority !== undefined
      || f.confidence !== undefined || f.needsCorrection !== undefined
      || f.lastReviewedAt !== undefined || f.reviewCount !== undefined;
    if (hasValue) {
      clean.flags = { ...f };
    }
  }
  if (annotation.groups !== undefined && annotation.groups.length > 0) {
    clean.groups = annotation.groups;
  }
  if (annotation.motivation !== undefined) {
    clean.motivation = annotation.motivation;
  }
  if (annotation.alias !== undefined) {
    clean.alias = annotation.alias;
  }
  return clean;
}
