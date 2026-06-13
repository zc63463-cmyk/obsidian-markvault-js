/**
 * annotation-repo.ts — 薄代理层
 *
 * Phase 2: 所有 Dexie 调用已替换为 AnnotationStore 调用。
 * 对外接口保持兼容，仅 addAnnotation/updateAnnotation 返回值变更。
 */

import { annotationStore } from './annotation-store';
import type { Annotation, AnnotationFilter, AnnotationStats, BatchUpdateItem } from '../types/annotation';

// ─── CRUD ──────────────────────────────────────────────

/** 添加标注（返回 void，不再返回自增 id） */
export async function addAnnotation(annotation: Annotation): Promise<void> {
  await annotationStore.addAnnotation(annotation);
}

/** 通过 uuid 获取标注 */
export async function getAnnotationByUuid(uuid: string): Promise<Annotation | undefined> {
  await annotationStore.ensureFileLoadedForUuid(uuid);
  return annotationStore.getAnnotationByUuid(uuid);
}

/** 更新标注（返回 void，不再返回修改数量） */
export async function updateAnnotation(uuid: string, changes: Partial<Annotation>): Promise<void> {
  await annotationStore.updateAnnotation(uuid, changes);
}

/** 删除标注 */
export async function deleteAnnotation(uuid: string): Promise<void> {
  await annotationStore.deleteAnnotation(uuid);
}

// ─── 批量查询 ─────────────────────────────────────────

/** 获取指定笔记的所有标注（按文档顺序） */
export async function getAnnotationsForFile(filePath: string): Promise<Annotation[]> {
  await annotationStore.ensureFileLoaded(filePath);
  return annotationStore.getAnnotationsForFile(filePath);
}

/** 获取所有已加载的标注 */
export async function getAllAnnotations(): Promise<Annotation[]> {
  return annotationStore.getAllAnnotations();
}

/** 删除指定笔记的所有标注 */
export async function deleteAnnotationsForFile(filePath: string): Promise<void> {
  await annotationStore.deleteAnnotationsForFile(filePath);
}

// ─── 过滤查询 ─────────────────────────────────────────

/** 按过滤条件查询标注 */
export async function queryAnnotations(filter: AnnotationFilter): Promise<Annotation[]> {
  return annotationStore.queryAnnotations(filter);
}

// ─── 统计 ─────────────────────────────────────────────

/** 获取指定笔记的标注统计 */
export async function getAnnotationStats(filePath: string): Promise<AnnotationStats> {
  await annotationStore.ensureFileLoaded(filePath);
  return annotationStore.getAnnotationStats(filePath);
}

// ─── 偏移修正 ─────────────────────────────────────────

/** 批量修正偏移量（文件打开时使用，不更新 updatedAt） */
export async function batchUpdateOffsets(updates: BatchUpdateItem[]): Promise<void> {
  await annotationStore.batchUpdateOffsets(updates);
}

/** 增量偏移修正：编辑后对变更位置之后的标注做偏移调整 */
export async function adjustOffsetsAfterEdit(
  filePath: string,
  changeStart: number,
  changeEnd: number,
  insertedLen: number,
): Promise<void> {
  await annotationStore.ensureFileLoaded(filePath);
  const deletedLen = changeEnd - changeStart;
  const delta = insertedLen - deletedLen;

  if (delta === 0) return; // 替换等长文本，偏移不变

  const annotations = annotationStore.getAnnotationsForFile(filePath);
  const updates: BatchUpdateItem[] = [];

  for (const a of annotations) {
    if (a.startOffset > changeStart) {
      updates.push({
        uuid: a.uuid,
        startOffset: a.startOffset + delta,
        endOffset: a.endOffset + delta,
        spanRanges: a.spanRanges?.map(r => ({
          from: r.from > changeStart ? r.from + delta : r.from,
          to: r.to > changeStart ? r.to + delta : r.to,
        })),
      });
    }
  }

  if (updates.length > 0) {
    await annotationStore.batchUpdateOffsets(updates);
  }
}

// ─── 字段查询 ─────────────────────────────────────────

/** 获取所有已加载标注中出现过的字段键名列表 */
export function getFieldKeys(): string[] {
  return annotationStore.getFieldKeys();
}

/** 获取指定字段键的所有已出现值列表 */
export function getFieldValues(key: string): string[] {
  return annotationStore.getFieldValues(key);
}
